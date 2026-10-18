# Production setup

The repository now includes trusted reservation functions, branch capacity,
waitlisting, email jobs, reminders, password reset, email verification, data
export/deletion, QR tickets, CSV export, privacy terms, and hardened rules.

## Required services

1. Upgrade the Firebase project to Blaze. Cloud Functions and scheduled
   reminders require billing.
2. Deploy indexes and rules:

   ```sh
   firebase deploy --only firestore
   ```

3. Deploy functions:

   ```sh
   cd functions && npm install && cd ..
   firebase deploy --only functions
   ```

4. Install Firebase's **Trigger Email** extension and configure it to process
   the `mail` collection. Functions write confirmation, reschedule,
   cancellation, and reminder messages there. Configure the business sender
   address and SMTP provider in the extension.
5. Create a reCAPTCHA Enterprise site key. Add this tag to every HTML `<head>`:

   ```html
   <meta name="firebase-app-check-site-key" content="YOUR_SITE_KEY">
   ```

   Confirm valid tokens in production, then change all callable functions from
   `enforceAppCheck: false` to `enforceAppCheck: true` and redeploy.

## Data migration

Existing `branches/{id}` documents need integer `capacity` values from 1 to
500. Set each branch capacity in the Firebase console before deploying the new
rules, or edit each branch through the manager dashboard immediately afterward.

## Local tests

Install Java 21, then run:

```sh
npx firebase emulators:exec --only firestore --project demo-unli "cd scripts && npm run test:rules"
```

Test Functions with:

```sh
firebase emulators:start --only auth,firestore,functions,hosting
```

Open `http://127.0.0.1:5000/login.html?emulator`.

## Before launch

- Replace placeholder business contact language in `privacy.html` and
  `terms.html` with the registered business name and contact details.
- Configure authorized Auth domains and password-reset templates.
- Verify the Trigger Email sender and reply-to address.
- Enable App Check enforcement after all pages include the production key.
- Set Firebase budget alerts and review Cloud Logging alerts.
- Run rules tests, booking/capacity tests, mobile checks, and accessibility
  checks before each deployment.

SMS and online deposits need chosen providers and credentials. Keep provider
secrets in Firebase Secret Manager, never in `public/` or source control.
