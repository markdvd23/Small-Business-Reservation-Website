# Unli Chix

Static site on Firebase Hosting, with Firebase Auth and Firestore.

## Layout

```
public/                 served by Firebase Hosting (URLs match this folder)
  index.html            home
  menu.html             the feast
  branches.html         branches, from Firestore
  login.html            sign in / sign up
  dashboard.html        staff + manager board
  accounts/guest/       guest landing
  accounts/user/        customer account, booking, ticket pages
  css/                  styles.css (site), dashboard.css (board)
  js/                   session, firebase, app (store + booking modal), page scripts
  assets/               images
scripts/                admin tools, never deployed
  lib/admin.mjs         shared Firestore admin connection
  data/                 menu.json, branches.json
  seed-*.mjs            seed menu, branches, demo data
  rules.test.mjs        firestore.rules tests
docs/                   plan, account notes, skill copies
firestore.rules         who can read and write what
firebase.json           hosting, rules, emulators
.secrets/               service account key (gitignored)
```

## Commands

Scripts use `.secrets/service-account.json` by default (Firebase console → Project settings → Service accounts → Generate new private key).

```sh
cd scripts && npm install

node seed-menu.mjs            # dishes from data/menu.json    (--dry-run, --overwrite)
node seed-branches.mjs        # branches from data/branches.json (create-only)
node seed-demo.mjs            # demo tickets, logs, branches  (--dry-run, --remove)
```

Deploy:

```sh
firebase deploy --only firestore:rules
firebase deploy --only hosting
```

Rules tests (Java 21+):

```sh
firebase emulators:exec --only firestore --project demo-unli "cd scripts && npm run test:rules"
```

Local site: `firebase emulators:start`, seed with `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/seed-menu.mjs`, open `http://127.0.0.1:5000/login.html?emulator`.

More: [docs/accounts.md](docs/accounts.md) (roles, menu editing), [docs/plan.md](docs/plan.md).
