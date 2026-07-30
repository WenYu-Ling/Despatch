const express = require('express');
const webpush = require('web-push');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ⚠️ 保留您設定好的 VAPID Key
const publicVapidKey = 'BINKDYoRVfyrjbpsxugYEJF35OvBgGBxHD9hEnrFrB45xC_Jp0jRC8jNrqaut_bx2uWEtrfySqZ8cQyUG6rYxZk';
const privateVapidKey = 'i5bcWTflgfimEropoXIndRm46rX4KNZeGU0aTSvKUQI';

webpush.setVapidDetails(
  'mailto:health@university.edu.tw',
  publicVapidKey,
  privateVapidKey
);

let subscriptions = [];
let activeMissions = []; // 結構: { id, type, location, detail, status, createdAt, closedAt, responseLogs: [], chatMessages: [] }
let studentStatus = {};
let customLocations = ['綜合教學大樓', '教穡大樓', '圖資館', '體育館', '操場', '風雨球場', '格致大樓', '電資二館', '工學院', '生資院', '人管院'];

let sseClients = [];

function broadcastSSE(data) {
  sseClients.forEach(client => client.res.write(`data: ${JSON.stringify(data)}\n\n`));
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

// 2. 訂閱 Push API
app.post('/api/subscribe', (req, res) => {
  const subscription = req.body;
  if (!subscriptions.find(sub => sub.endpoint === subscription.endpoint)) {
    subscriptions.push(subscription);
  }
  res.status(201).json({ success: true });
});

// 3. 發起派遣 API
app.post('/api/dispatch', (req, res) => {
  const { type, location, detail } = req.body;
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
    chatMessages: [] // 案件專屬對話紀錄
  };

  activeMissions.unshift(mission);

  broadcastSSE({ action: 'UPDATE_ALL', activeMissions, studentStatus });

  const payload = JSON.stringify({
    title: `【緊急派遣 ${nowStr}】${type}`,
    body: `地點：${location}${detail ? ` (${detail})` : ''}\n請立即確認！`,
    url: '/student.html'
  });

  Promise.all(
    subscriptions.map(sub =>
      webpush.sendNotification(sub, payload).catch(err => console.error('Push Error:', err))
    )
  );

  res.json({ success: true, mission });
});

// 4. 隊員狀態與案件訊息傳送 API
app.post('/api/student/status', (req, res) => {
  const { name, status, missionId, reportText } = req.body;
  const nowStr = getTimeToMinute();
  
  if (status === '現場訊息') {
    if (missionId) {
      const targetMission = activeMissions.find(m => m.id === Number(missionId));
      if (targetMission) {
        targetMission.chatMessages.push({
          sender: name,
          role: 'student',
          text: reportText,
          time: nowStr
        });
      }
    }
  } else {
    // 更新隊員個人狀態與時間戳記
    studentStatus[name] = { 
      status: (status === 'Off Duty') ? 'Off Duty' : 'On Duty', 
      updatedAt: nowStr,
      timestamp: Date.now() 
    };

    if (missionId) {
      const targetMission = activeMissions.find(m => m.id === Number(missionId));
      if (targetMission) {
        // 1. 只要有回應，記錄一律推入 responseLogs (這樣所有人接受/到場/拒絕都會被上記錄)
        targetMission.responseLogs.push({
          id: Date.now(),
          name,
          status,
          time: nowStr
        });

        // 2. 更新案件整體的核心狀態 (只要有人接單或到場，就更新案件的主標籤)
        if (status === '已接單' && targetMission.status === '派遣中') {
          targetMission.status = '已接單';
        } else if (status === '已到場') {
          targetMission.status = '已到場';
        }
      }
    }
  }

  broadcastSSE({ action: 'UPDATE_ALL', studentStatus, activeMissions });
  res.json({ success: true });
});

// 5. 衛保組發送案件補充訊息/指令 API
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
  if (location && !customLocations.includes(location)) {
    customLocations.push(location);
  }
  broadcastSSE({ action: 'LOCATION_UPDATE', customLocations });
  res.json(customLocations);
});
app.delete('/api/locations', (req, res) => {
  const { location } = req.body;
  customLocations = customLocations.filter(loc => loc !== location);
  broadcastSSE({ action: 'LOCATION_UPDATE', customLocations });
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

// 11. 手動刪除不線上成員 API
app.post('/api/student/remove', (req, res) => {
  const { name } = req.body;
  if (name && studentStatus[name]) {
    delete studentStatus[name];
    broadcastSSE({ action: 'UPDATE_ALL', activeMissions, studentStatus });
  }
  res.json({ success: true });
});

// 12. 超過 10 分鐘未更新自動刪除成員機制
setInterval(() => {
  const now = Date.now();
  let hasChanges = false;

  for (const [name, info] of Object.entries(studentStatus)) {
    if (!info.timestamp) {
      info.timestamp = now;
      continue;
    }

    // 10 分鐘 = 600,000 毫秒
    if (now - info.timestamp > 10 * 60 * 1000) {
      delete studentStatus[name];
      hasChanges = true;
    }
  }

  if (hasChanges) {
    broadcastSSE({ action: 'UPDATE_ALL', activeMissions, studentStatus });
  }
}, 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`派遣系統已於 http://localhost:${PORT} 啟動`));