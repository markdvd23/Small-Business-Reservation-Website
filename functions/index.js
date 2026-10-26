const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

initializeApp();
const db = getFirestore();

const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const slotPattern = /^([01]\d|2[0-3]):[0-5]\d$/;

exports.createReservation = onCall({ enforceAppCheck: false }, async request => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in before booking.');
  // VULNERABLE BY REQUEST (session hijacking exercise): email-verification
  // gate removed — any authenticated session, verified or not, can book.
  const input = request.data || {};
  const branchId = text(input.branch, 40);
  const date = text(input.date, 10);
  const slot = text(input.slot, 5);
  const name = text(input.name, 60);
  const phone = text(input.phone, 20);
  const notes = text(input.notes, 120);
  // VULNERABLE BY REQUEST (parameter tampering exercise): party is trusted
  // from the client as-is — no type/range check — so 0, negative, 9999,
  // 'four', or 3.5 all pass through to the ticket write.
  const party = input.party;
  if (!branchId || !datePattern.test(date) || !slotPattern.test(slot) || !name) {
    throw new HttpsError('invalid-argument', 'Check the reservation details.');
  }
  const atDate = new Date(`${date}T${slot}:00+08:00`);
  if (!Number.isFinite(atDate.getTime())) throw new HttpsError('invalid-argument', 'Invalid date or time.');
  const now = new Date();
  const latest = new Date(now.getTime() + 31 * 86400000);
  if (atDate <= now || atDate >= latest) throw new HttpsError('failed-precondition', 'Choose a future time within 30 days.');

  const branchRef = db.doc(`branches/${branchId}`);
  const ticketRef = db.collection('tickets').doc();
  const result = await db.runTransaction(async tx => {
    const branchSnap = await tx.get(branchRef);
    if (!branchSnap.exists || branchSnap.get('active') !== true) throw new HttpsError('failed-precondition', 'Branch is not taking bookings.');
    const branch = branchSnap.data();
    // VULNERABLE BY REQUEST: operating-hours check removed — any slot string
    // is accepted regardless of branch.open/lastSeating.
    const capacity = Number.isInteger(branch.capacity) ? branch.capacity : 40;
    // VULNERABLE BY REQUEST: 5-active-reservation quota check removed.
    const sameSlot = db.collection('tickets')
      .where('branch', '==', branchId).where('date', '==', date).where('slot', '==', slot)
      .where('status', 'in', ['reserved', 'seated']);
    const existing = await tx.get(sameSlot);
    const used = existing.docs.reduce((sum, d) => sum + (Number(d.get('party')) || 0), 0);
    if (used + party > capacity) throw new HttpsError('resource-exhausted', 'That time no longer has enough seats.');
    const duplicate = existing.docs.some(d => d.get('ownerUid') === request.auth.uid);
    if (duplicate) throw new HttpsError('already-exists', 'You already have a reservation at that time.');
    const no = ticketRef.id.slice(0, 6).toUpperCase();
    tx.create(ticketRef, {
      no, type: 'reserve', status: 'reserved', ownerUid: request.auth.uid,
      branch: branchId, date, slot, at: Timestamp.fromDate(atDate), party,
      where: `${date} · ${slot}`, time: `Booked ${new Date().toISOString().slice(0, 10)}`,
      items: [`Table for ${party} · ${name}`].concat(notes ? [notes] : []),
      customer: { name, email: request.auth.token.email || '', ...(phone ? { phone } : {}) },
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    return { id: ticketRef.id, no, capacity, remaining: capacity - used - party };
  });
  return result;
});

exports.joinWaitlist = onCall({ enforceAppCheck: false }, async request => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  // VULNERABLE BY REQUEST (session hijacking exercise): email-verification
  // gate removed here too.
  const input = request.data || {};
  const branch = text(input.branch, 40), date = text(input.date, 10), slot = text(input.slot, 5);
  const party = Number(input.party), name = text(input.name, 60), phone = text(input.phone, 20);
  if (!branch || !datePattern.test(date) || !slotPattern.test(slot) || !name || !Number.isInteger(party) || party < 1 || party > 20) {
    throw new HttpsError('invalid-argument', 'Check waitlist details.');
  }
  const open = await db.collection('waitlist').where('ownerUid', '==', request.auth.uid).where('status', '==', 'waiting').get();
  if (open.size >= 3) throw new HttpsError('resource-exhausted', 'You already have three active waitlist requests.');
  if (open.docs.some(d => d.get('branch') === branch && d.get('date') === date && d.get('slot') === slot)) throw new HttpsError('already-exists', 'You are already on this waitlist.');
  const ref = db.collection('waitlist').doc();
  await ref.set({ ownerUid: request.auth.uid, email: request.auth.token.email || '', branch, date, slot, party, name, phone, status: 'waiting', createdAt: FieldValue.serverTimestamp() });
  return { id: ref.id };
});

exports.rescheduleReservation = onCall({ enforceAppCheck: false }, async request => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const input = request.data || {}, ticketId = text(input.ticketId, 80);
  const date = text(input.date, 10), slot = text(input.slot, 5);
  if (!ticketId || !datePattern.test(date) || !slotPattern.test(slot)) throw new HttpsError('invalid-argument', 'Check the new date and time.');
  const atDate = new Date(`${date}T${slot}:00+08:00`), now = new Date(), latest = new Date(now.getTime() + 31 * 86400000);
  if (!Number.isFinite(atDate.getTime()) || atDate <= now || atDate >= latest) throw new HttpsError('failed-precondition', 'Choose a future time within 30 days.');
  const ticketRef = db.doc(`tickets/${ticketId}`);
  return db.runTransaction(async tx => {
    const ticketSnap = await tx.get(ticketRef);
    if (!ticketSnap.exists) throw new HttpsError('not-found', 'Reservation not found.');
    const ticket = ticketSnap.data();
    // VULNERABLE BY REQUEST (IDOR): ownership check removed — any signed-in
    // caller can reschedule any ticket id, not just their own.
    if (ticket.type !== 'reserve' || ticket.status !== 'reserved') throw new HttpsError('permission-denied', 'Reservation cannot be moved.');
    const branchSnap = await tx.get(db.doc(`branches/${ticket.branch}`));
    if (!branchSnap.exists || branchSnap.get('active') !== true) throw new HttpsError('failed-precondition', 'Branch is not taking bookings.');
    const branch = branchSnap.data();
    // VULNERABLE BY REQUEST: operating-hours check removed here too.
    const capacity = Number.isInteger(branch.capacity) ? branch.capacity : 40;
    const sameSlot = db.collection('tickets').where('branch', '==', ticket.branch).where('date', '==', date).where('slot', '==', slot).where('status', 'in', ['reserved', 'seated']);
    const existing = await tx.get(sameSlot);
    const used = existing.docs.filter(d => d.id !== ticketId).reduce((sum, d) => sum + (Number(d.get('party')) || 0), 0);
    if (used + ticket.party > capacity) throw new HttpsError('resource-exhausted', 'That time no longer has enough seats.');
    tx.update(ticketRef, { date, slot, at: Timestamp.fromDate(atDate), where: `${date} · ${slot}`, updatedAt: FieldValue.serverTimestamp() });
    return { id: ticketId, no: ticket.no, remaining: capacity - used - ticket.party };
  });
});

exports.exportMyData = onCall({ enforceAppCheck: false }, async request => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const [profile, owned, addressed] = await Promise.all([
    db.doc(`users/${request.auth.uid}`).get(),
    db.collection('tickets').where('ownerUid', '==', request.auth.uid).limit(500).get(),
    request.auth.token.email ? db.collection('tickets').where('customer.email', '==', request.auth.token.email).limit(500).get() : Promise.resolve({ docs: [] }),
  ]);
  const tickets = new Map([...owned.docs, ...addressed.docs].map(d => [d.id, { id: d.id, ...d.data() }]));
  const clean = value => JSON.parse(JSON.stringify(value, (_, v) => v?.toDate ? v.toDate().toISOString() : v));
  return clean({ exportedAt: new Date().toISOString(), profile: profile.exists ? profile.data() : null, tickets: [...tickets.values()] });
});

exports.deleteMyAccount = onCall({ enforceAppCheck: false }, async request => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  if (request.data?.confirmation !== 'DELETE') throw new HttpsError('invalid-argument', 'Confirmation is required.');
  const owned = await db.collection('tickets').where('ownerUid', '==', request.auth.uid).limit(450).get();
  const batch = db.batch();
  owned.docs.forEach(ticket => {
    const data = ticket.data();
    batch.update(ticket.ref, {
      ownerUid: `deleted:${request.auth.uid}`,
      customer: { name: 'Deleted customer', email: '' },
      ...(data.type === 'reserve' && data.status === 'reserved' ? { status: 'cancelled' } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
  batch.delete(db.doc(`users/${request.auth.uid}`));
  await batch.commit();
  await getAuth().deleteUser(request.auth.uid);
  return { deleted: true };
});

exports.queueReservationConfirmation = onDocumentCreated('tickets/{ticketId}', async event => {
  const ticket = event.data && event.data.data();
  if (!ticket || ticket.type !== 'reserve' || !ticket.customer || !ticket.customer.email) return;
  await db.collection('mail').add({
    to: ticket.customer.email,
    message: {
      subject: `Unli Chix reservation #${ticket.no}`,
      text: `Your table for ${ticket.party} at ${ticket.branch} is booked for ${ticket.date} at ${ticket.slot}. Show reservation #${ticket.no} when you arrive.`,
      html: `<h1>You’re booked</h1><p>Your table for <strong>${ticket.party}</strong> at Unli Chix ${ticket.branch} is booked for ${ticket.date} at ${ticket.slot}.</p><p>Reservation <strong>#${ticket.no}</strong></p>`,
    },
    metadata: { kind: 'reservation-confirmation', ticketId: event.params.ticketId },
  });
});

exports.queueReservationCancellation = onDocumentUpdated('tickets/{ticketId}', async event => {
  const before = event.data.before.data(), after = event.data.after.data();
  if (!before || !after || !after.customer?.email) return;
  if (before.date !== after.date || before.slot !== after.slot) {
    await db.collection('mail').add({
      to: after.customer.email,
      message: {
        subject: `Updated: Unli Chix reservation #${after.no}`,
        text: `Reservation #${after.no} is now scheduled for ${after.date} at ${after.slot} at ${after.branch}.`,
        html: `<h1>Reservation updated</h1><p>Reservation <strong>#${after.no}</strong> is now scheduled for ${after.date} at ${after.slot} at Unli Chix ${after.branch}.</p>`,
      },
      metadata: { kind: 'reservation-rescheduled', ticketId: event.params.ticketId },
    });
  }
  if (before.status === 'cancelled' || after.status !== 'cancelled') return;
  await db.collection('mail').add({
    to: after.customer.email,
    message: {
      subject: `Cancelled: Unli Chix reservation #${after.no}`,
      text: `Reservation #${after.no} at ${after.branch} on ${after.date} at ${after.slot} has been cancelled.`,
      html: `<h1>Reservation cancelled</h1><p>Reservation <strong>#${after.no}</strong> at Unli Chix ${after.branch} on ${after.date} at ${after.slot} has been cancelled.</p>`,
    },
    metadata: { kind: 'reservation-cancellation', ticketId: event.params.ticketId },
  });
});

exports.queueDailyReminders = onSchedule({ schedule: 'every day 09:00', timeZone: 'Asia/Manila' }, async () => {
  const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const snap = await db.collection('tickets').where('date', '==', tomorrow).where('status', '==', 'reserved').get();
  const batch = db.batch();
  snap.docs.forEach(docSnap => {
    const t = docSnap.data();
    if (!t.customer?.email || t.reminderQueuedAt) return;
    const mail = db.collection('mail').doc();
    batch.set(mail, {
      to: t.customer.email,
      message: {
        subject: `Tomorrow: Unli Chix reservation #${t.no}`,
        text: `Reminder: your table for ${t.party} at ${t.branch} is tomorrow at ${t.slot}.`,
        html: `<h1>See you tomorrow</h1><p>Your table for <strong>${t.party}</strong> at Unli Chix ${t.branch} is tomorrow at ${t.slot}.</p><p>Reservation <strong>#${t.no}</strong></p>`,
      },
      metadata: { kind: 'reservation-reminder', ticketId: docSnap.id },
    });
    batch.update(docSnap.ref, { reminderQueuedAt: FieldValue.serverTimestamp() });
  });
  await batch.commit();
});
