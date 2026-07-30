// 監聽 Web Push
self.addEventListener('push', function(event) {
  if (!event.data) return;

  try {
    const data = event.data.json();

    const options = {
      body: data.body,
      icon: '/icon/icon-192.png',
      badge: '/icon/icon-192.png',
      
      // 震動
      vibrate: [1000, 200, 1000, 200, 500, 100, 500, 100, 500],
      
      tag: 'emergency-dispatch',
      renotify: true,
      requireInteraction: true,
      data: { url: data.url || '/student.html' }
    };

    event.waitUntil(
      self.registration.showNotification(data.title, options)
    );
  } catch (err) {
    console.error('Push event handle error:', err);
  }
});

// 點擊通知喚醒
self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  const targetUrl = (event.notification.data && event.notification.data.url) ? event.notification.data.url : '/student.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (let i = 0; i < clientList.length; i++) {
        let client = clientList[i];
        if (client.url.includes('/student.html') && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});