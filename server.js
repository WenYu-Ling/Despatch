const express = require('express');
const webpush = require('web-push');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const publicVapidKey = 'BINKDYoRVfyrjbpsxugYEJF35OvBgGBxHD9hEnrFrB45xC_Jp0jRC8jNrqaut_bx2uWEtrfySqZ8cQyUG6rYxZk';
const privateVapidKey = 'i5bcWTflgfimEropoXIndRm46rX4KNZeGU0aTSvKUQI';

webpush.setVapidDetails(
  'mailto:health@university.edu.tw',
  publicVapidKey,
  privateVapidKey
);

let subscriptions = [];
let activeMissions = []; 
let studentStatus = {};
let customLocations = ['綜合教學大樓', '教穡大樓', '圖資館', '體育館', '操場', '風雨球場', '格致大樓', '電資二館', '工學院', '生資院', '人管院'];

let sseClients = [];

function broadcastSSE(data) {
  const payload = { customLocations, ...data };
  sseClients.forEach(client => {
    try {
      client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (err) {
      console.error('SSE write error:', err);
    }
  });
}

function getTimeToMinute() {
  const now = new Date();
  const options = {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  };
  return new Intl.DateTimeFormat('zh-TW', options).format(now);
}

// 1. VAPID Key API
app.get('/api/vapid-public-key', (req, res) => res.json({ publicKey: publicVapidKey }));

// 2. Push API
app.post('/api/subscribe', (req, res) => {
  const { subscription, name } = req.body;
  if (subscription && subscription.endpoint && name) {
    subscriptions = subscriptions.filter(sub => sub.name !== name);
    subscriptions.push({ name, ...subscription });
  }
  res.status(201).json({ success: true });
});

// 3. 派遣 API
app.post('/api/dispatch', (req, res) => {
  const { type, location, detail } = req.body;
  if (!type || !location) {
    return res.status(400).json({ success: false, error: 'Type and location are required.' });
  }

  const nowStr = getTimeToMinute();

  const mission = {
    id: Date.now(),
    type,
    location,
    detail: detail || '',
    status: '派遣中',
    createdAt: nowStr,
    closedAt: null,
    responseLogs: [],
    chatMessages: []
  };

  activeMissions.unshift(mission);

  broadcastSSE({ action: 'UPDATE_ALL', activeMissions, studentStatus });

  const payload = JSON.stringify({
    title: `【緊急派遣 ${nowStr}】${type}`,
    body: `地點：${location}${detail ? ` (${detail})` : ''}\n請立即確認！`,
    url: '/student.html'
  });

  const onDutySubscriptions = subscriptions.filter(sub => {
    return studentStatus[sub.name] && studentStatus[sub.name].status === 'On Duty';
  });

  Promise.all(
    onDutySubscriptions.map(sub =>
      webpush.sendNotification(sub, payload).catch(err => {
        console.error('Push Error:', err);
        subscriptions = subscriptions.filter(s => s.endpoint !== sub.endpoint);
      })
    )
  );

  res.json({ success: true, mission });
});

// 4. 狀態與訊息傳送 API
app.post('/api/student/status', (req, res) => {
  const { name, status, missionId, reportText } = req.body;
  if (!name || !status) {
    return res.status(400).json({ success: false, error: 'Name and status are required.' });
  }

  const nowStr = getTimeToMinute();
  
  if (status === '現場訊息') {
    if (missionId) {
      const targetMission = activeMissions.find(m => m.id === Number(missionId));
      if (targetMission) {
        targetMission.chatMessages.push({
          sender: name,
          role: 'student',
          text: reportText || '',
          time: nowStr
        });
      }
    }
  } else {
    studentStatus[name] = { 
      status: (status === 'Off Duty') ? 'Off Duty' : 'On Duty', 
      updatedAt: nowStr,
      timestamp: Date.now() 
    };

    if (missionId) {
      const targetMission = activeMissions.find(m => m.id === Number(missionId));
      if (targetMission) {
        targetMission.responseLogs.push({
          id: Date.now(),
          name,
          status,
          time: nowStr
        });
        if (status === '已接案' && targetMission.status === '派遣中') {
          targetMission.status = '已接案';
        } else if (status === '已到場') {
          targetMission.status = '已到場';
        }
      }
    }
  }

  broadcastSSE({ action: 'UPDATE_ALL', studentStatus, activeMissions });
  res.json({ success: true });
});

// 5. 派遣端發送訊息 API
app.post('/api/missions/chat', (req, res) => {
  const { missionId, message } = req.body;
  const nowStr = getTimeToMinute();

  const targetMission = activeMissions.find(m => m.id === Number(missionId));
  if (targetMission && message) {
    targetMission.chatMessages.push({
      sender: '派遣端',
      role: 'admin',
      text: message,
      time: nowStr
    });
    broadcastSSE({ action: 'UPDATE_ALL', activeMissions, studentStatus });
  }

  res.json({ success: true });
});

// 6. 單獨結案 API
app.post('/api/missions/close-single', (req, res) => {
  const { id } = req.body;
  const mission = activeMissions.find(m => m.id === id);
  if (mission) {
    mission.status = '已結案';
    mission.closedAt = getTimeToMinute();
  }
  broadcastSSE({ action: 'UPDATE_ALL', activeMissions, studentStatus });
  res.json({ success: true });
});

// 7. 單獨刪除案件 API
app.post('/api/missions/delete-single', (req, res) => {
  const { id } = req.body;
  activeMissions = activeMissions.filter(m => m.id !== id);
  broadcastSSE({ action: 'UPDATE_ALL', activeMissions, studentStatus });
  res.json({ success: true });
});

// 8. 清除所有記錄 API
app.post('/api/missions/clear', (req, res) => {
  activeMissions = [];
  broadcastSSE({ action: 'UPDATE_ALL', activeMissions, studentStatus });
  res.json({ success: true });
});

// 9. 地點管理 API
app.get('/api/locations', (req, res) => res.json(customLocations));

app.post('/api/locations', (req, res) => {
  const { location } = req.body;
  if (location && typeof location === 'string' && !customLocations.includes(location.trim())) {
    customLocations.push(location.trim());
  }
  broadcastSSE({ action: 'LOCATION_UPDATE', customLocations, activeMissions, studentStatus });
  res.json(customLocations);
});

app.delete('/api/locations', (req, res) => {
  const { location } = req.body;
  customLocations = customLocations.filter(loc => loc !== location);
  broadcastSSE({ action: 'LOCATION_UPDATE', customLocations, activeMissions, studentStatus });
  res.json(customLocations);
});

// 10. SSE 連線 API
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const clientId = Date.now();
  sseClients.push({ id: clientId, res });

  res.write(`data: ${JSON.stringify({ action: 'INIT', activeMissions, studentStatus, customLocations })}\n\n`);

  req.on('close', () => {
    sseClients = sseClients.filter(client => client.id !== clientId);
  });
});

// 11. 手動刪除成員 API
app.post('/api/student/remove', (req, res) => {
  const { name } = req.body;
  if (name && studentStatus[name]) {
    delete studentStatus[name];
    broadcastSSE({ 
      action: 'REMOVE_STUDENT', 
      removedName: name, 
      activeMissions, 
      studentStatus 
    });
  }
  res.json({ success: true });
});

// 12. Ping
setInterval(() => {
  sseClients.forEach(client => {
    try {
      client.res.write(': ping\n\n');
    } catch (e) {
    }
  });
}, 45000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`派遣系統已於 http://localhost:${PORT} 啟動`));