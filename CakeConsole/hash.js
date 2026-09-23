// Usage: npm run hash -- "your new password"
// Prints a value for admin.passwordHash in config.json
const crypto = require('crypto');
const pw = process.argv[2];
if (!pw) { console.log('Usage: npm run hash -- "your password"'); process.exit(1); }
const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(pw, salt, 64);
console.log(`scrypt$${salt.toString('hex')}$${hash.toString('hex')}`);
