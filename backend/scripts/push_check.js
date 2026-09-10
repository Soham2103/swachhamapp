/**
 * Checks whether push notifications are actually working, end to end.
 *
 * SENDS NOTHING TO A REAL DEVICE unless you name one. By default it proves
 * the two things that can be proven without a phone:
 *
 *   1. the Firebase credentials in .env are accepted by Google, and
 *   2. Cloud Messaging answers this project.
 *
 * It does that by authenticating for real and then sending to a deliberately
 * INVALID token. Firebase rejecting only the token is the signal that
 * everything before the token is right — a bad key never gets that far.
 *
 * It then lists the devices that have registered, which is the part no log
 * line can tell you: a server that sends perfectly still delivers nothing if
 * no handset has ever signed in.
 *
 * Usage:
 *   npm run push:check                 credentials + registered devices
 *   npm run push:check -- --send 12    ALSO sends a real test notification
 *                                      to every device of user id 12
 *
 * The --send form puts a real notification on a real phone, so it asks for a
 * user id rather than guessing one.
 */
require('dotenv').config();

const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

const PROJECT = (process.env.FIREBASE_PROJECT_ID || '').trim();
const EMAIL = (process.env.FIREBASE_CLIENT_EMAIL || '').trim();

/**
 * The private key, unwrapped from whatever the .env wrapped it in.
 *
 * Mirrors `normalisePrivateKey` in push.service.ts on purpose: this script
 * has to agree with the server about what the key is, or it would report a
 * problem the server does not have (or miss one it does).
 */
function normalisePrivateKey(raw) {
  let key = String(raw || '').trim();
  if (key.endsWith(',')) key = key.slice(0, -1).trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }
  return key.replace(/\\n/g, '\n');
}

const KEY = normalisePrivateKey(process.env.FIREBASE_PRIVATE_KEY);

const args = process.argv.slice(2);
const sendIndex = args.indexOf('--send');
const sendToUserId = sendIndex >= 0 ? args[sendIndex + 1] : null;

function line(label, value) {
  console.log('  ' + String(label).padEnd(22) + value);
}

async function main() {
  console.log('\n=== 1. CONFIGURATION ===');
  const missing = [];
  if (!PROJECT) missing.push('FIREBASE_PROJECT_ID');
  if (!EMAIL) missing.push('FIREBASE_CLIENT_EMAIL');
  if (!KEY) missing.push('FIREBASE_PRIVATE_KEY');

  line('project id', PROJECT || '(not set)');
  line('client email', EMAIL || '(not set)');
  line('private key', KEY ? `${KEY.length} chars, looks like PEM: ${KEY.startsWith('-----BEGIN')}` : '(not set)');

  if (missing.length) {
    console.log('\n  ✗ Push is NOT configured. Missing: ' + missing.join(', '));
    console.log('    Nothing will be pushed; notifications still reach their');
    console.log('    durable rows exactly as before.');
    process.exit(1);
  }

  console.log('\n=== 2. CREDENTIALS ===');
  let app;
  try {
    app = initializeApp(
      { credential: cert({ projectId: PROJECT, clientEmail: EMAIL, privateKey: KEY }) },
      'push-check-' + Date.now()
    );
    line('initialise', 'OK');
  } catch (error) {
    line('initialise', 'FAILED — ' + error.message);
    console.log('\n  ✗ The private key could not be parsed. Copy `private_key` from');
    console.log('    the service-account JSON exactly, keeping the \\n sequences.');
    process.exit(1);
  }

  console.log('\n=== 3. CLOUD MESSAGING ===');
  try {
    await getMessaging(app).send({
      token: 'INVALID_TOKEN_FOR_PUSH_CHECK',
      notification: { title: 'check', body: 'check' },
    });
    line('result', 'a bogus token was ACCEPTED — unexpected');
  } catch (error) {
    const code = String(error.code || '');
    if (code.includes('invalid-argument') || code.includes('registration-token-not-registered')) {
      line('result', 'OK — authenticated; only the fake token was refused');
      line('code', code);
    } else {
      line('result', 'FAILED');
      line('code', code || '(none)');
      line('message', String(error.message).slice(0, 200));
      console.log('\n  ✗ Credentials worked but FCM refused. The Cloud Messaging API');
      console.log('    is usually not enabled for this project.');
      process.exit(1);
    }
  }

  console.log('\n=== 4. REGISTERED DEVICES ===');
  // Required lazily so steps 1-3 still run when the database is unreachable.
  const { query } = require(path.join(__dirname, '..', 'src', 'config', 'database'));

  let rows;
  try {
    const result = await query(
      `SELECT id, user_id, business_user_id, platform, is_active, last_seen_at
         FROM push_tokens ORDER BY id DESC LIMIT 20`
    );
    rows = result.rows;
  } catch (error) {
    line('database', 'could not read push_tokens — ' + error.message);
    console.log('    Is migration 068_push_tokens.sql applied?');
    process.exit(1);
  }

  if (!rows.length) {
    console.log('  No device has registered yet.');
    console.log('\n  This is the usual reason "nothing arrives" while every log line');
    console.log('  looks healthy. Sign in on a DEVELOPMENT OR PREVIEW BUILD (Expo Go');
    console.log('  on Android cannot receive push) and watch the server log for:');
    console.log('    [Push] Registered a android device for user_id=…');
  } else {
    rows.forEach((r) => {
      const owner = r.user_id ? `user ${r.user_id}` : `business_user ${r.business_user_id}`;
      console.log(
        `  #${r.id} ${owner.padEnd(22)} ${r.platform} ` +
          `${r.is_active ? 'active' : 'INACTIVE'} last seen ${r.last_seen_at || '-'}`
      );
    });
  }

  if (sendToUserId) {
    console.log('\n=== 5. REAL TEST NOTIFICATION ===');
    console.log('  Sending to every device of user ' + sendToUserId + ' …');
    const { sendToUser } = require(path.join(__dirname, '..', 'src', 'services', 'push.service'));
    const result = await sendToUser(String(sendToUserId), {
      title: 'Swachham test notification',
      body: 'If you can read this, push notifications are working.',
      data: { type: 'PUSH_CHECK' },
    });
    line('sent', String(result.sent));
    line('failed', String(result.failed));
    if (result.error) line('error', result.error);
    if (result.sent > 0) {
      console.log('\n  ✓ Firebase accepted it. Look at the phone.');
      console.log('    If nothing appears there, the app has notifications blocked');
      console.log('    in Android settings, or it was delivered while in the');
      console.log('    foreground (the app decides how to show those).');
    }
  } else {
    console.log('\n  To send a real notification to a phone:');
    console.log('    npm run push:check -- --send <userId>');
  }

  console.log('');
  process.exit(0);
}

main().catch((error) => {
  console.error('\npush:check failed: ' + error.message);
  process.exit(1);
});
