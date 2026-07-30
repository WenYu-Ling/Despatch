const webpush = require('web-push');

const vapidKeys = webpush.generateVAPIDKeys();

console.log('\n===== 請複製以下 VAPID 金鑰並貼至 server.js =====\n');
console.log('Public Key:\n', vapidKeys.publicKey);
console.log('\nPrivate Key:\n', vapidKeys.privateKey);
console.log('\n================================================\n');