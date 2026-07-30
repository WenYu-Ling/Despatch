// public/sw.js

// 監聽背景 Web Push
self.addEventListener('push', function(event) {
  if (!event.data) return;

  const data = event.data.json();

  const options = {
    body: data.body,
    icon: 'icon/icon-192.png',
    badge: 'icon/icon-192.png',
    
    // 高頻急救震動節奏
    vibrate: [1000, 200, 1000, 200, 500, 100, 500, 100, 500],
    
    tag: 'emergency-dispatch',
    renotify: true,
    requireInteraction: true,
    data: { url: data.url || '/student.html' }
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// 點擊通知時直接打開或喚醒 PWA 畫面
self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (let i = 0; i < clientList.length; i++) {
        let client = clientList[i];
        if (client.url.includes('/student.html') && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(event.notification.data.url);
      }
    })
  );
});