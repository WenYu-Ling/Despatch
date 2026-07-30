const express = require('express');
const webpush = require('web-push');
const path = require('path');
const { Redis } = require('@upstash/redis');

// 初始化 Upstash Redis (自動讀取 Vercel 環境變數)
const redis = Redis.fromEnv();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const publicVapidKey = process.env.PUBLIC_VAPID_KEY || 'BINKDYoRVfyrjbpsxugYEJF35OvBgGBxHD9hEnrFrB45xC_Jp0jRC8jNrqaut_bx2uWEtrfySqZ8cQyUG6rYxZk';
const privateVapidKey = process.env.PRIVATE_VAPID_KEY || 'i5bcWTflgfimEropoXIndRm46rX4KNZeGU0aTSvKUQI';

webpush.setVapidDetails(
  'mailto:health@university.edu.tw',
  publicVapidKey,
  privateVapidKey
);

const DEFAULT_LOCATIONS = ['綜合教學大樓', '教穡大樓', '圖資館', '體育館', '操場', '風雨球場', '格致大樓', '電資二館', '工學院', '生資院', '人管院'];
let sseClients = [];

// 從 Redis 讀取全域資料
async function getSystemData() {
  const activeMissions = (await redis.get('activeMissions')) || [];
  const studentStatus = (await redis.get('studentStatus')) || {};
  const customLocations = (await redis.get('customLocations')) || DEFAULT_LOCATIONS;
  const subscriptions = (await redis.get('subscriptions')) || [];
  return { activeMissions, studentStatus, customLocations, subscriptions };
}

async function broadcastSSE(data = {}) {
  const systemData = await getSystemData();
  const payload = { 
    customLocations: systemData.customLocations,
    activeMissions: systemData.activeMissions,
    studentStatus: systemData.studentStatus,
    ...data 
  };

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

// 2. Push API (持久化寫入 Redis)
app.post('/api/subscribe', async (req, res) => {
  const { subscription, name } = req.body;
  if (subscription && subscription.endpoint && name) {
    let subscriptions = (await redis.get('subscriptions')) || [];
    subscriptions = subscriptions.filter(sub => sub.name !== name && sub.endpoint !== subscription.endpoint);
    subscriptions.push({ name, ...subscription });
    await redis.set('subscriptions', subscriptions);

    let studentStatus = (await redis.get('studentStatus')) || {};
    if (!studentStatus[name] || studentStatus[name].status === 'Off Duty') {
      studentStatus[name] = {
        status: 'On Duty',
        updatedAt: getTimeToMinute(),
        timestamp: Date.now()
      };
      await redis.set('studentStatus', studentStatus);
      await broadcastSSE({ action: 'UPDATE_ALL' });
    }
  }
  res.status(201).json({ success: true });
});

// 3. 派遣 API
app.post('/api/dispatch', async (req, res) => {
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

  let activeMissions = (await redis.get('activeMissions')) || [];
  activeMissions.unshift(mission);
  await redis.set('activeMissions', activeMissions);

  await broadcastSSE({ action: 'UPDATE_ALL' });

  const payload = JSON.stringify({
    title: `【緊急派遣 ${nowStr}】${type}`,
    body: `地點：${location}${detail ? ` (${detail})` : ''}\n請立即確認！`,
    url: '/student.html'
  });

  const subscriptions = (await redis.get('subscriptions')) || [];
  const studentStatus = (await redis.get('studentStatus')) || {};

  const targetSubscriptions = subscriptions.filter(sub => {
    const statusObj = studentStatus[sub.name];
    return !statusObj || statusObj.status !== 'Off Duty';
  });

  Promise.all(
    targetSubscriptions.map(sub =>
      webpush.sendNotification(sub, payload).catch(async err => {
        console.error('Push Error:', err);
        if (err.statusCode === 404 || err.statusCode === 410) {
          let currentSubs = (await redis.get('subscriptions')) || [];
          currentSubs = currentSubs.filter(s => s.endpoint !== sub.endpoint);
          await redis.set('subscriptions', currentSubs);
        }
      })
    )
  );

  res.json({ success: true, mission });
});

// 4. 狀態與訊息傳送 API
app.post('/api/student/status', async (req, res) => {
  const { name, status, missionId, reportText } = req.body;
  if (!name || !status) {
    return res.status(400).json({ success: false, error: 'Name and status are required.' });
  }

  const nowStr = getTimeToMinute();
  let activeMissions = (await redis.get('activeMissions')) || [];
  let studentStatus = (await redis.get('studentStatus')) || {};

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
        await redis.set('activeMissions', activeMissions);
      }
    }
  } else {
    studentStatus[name] = { 
      status: (status === 'Off Duty') ? 'Off Duty' : 'On Duty', 
      updatedAt: nowStr,
      timestamp: Date.now() 
    };
    await redis.set('studentStatus', studentStatus);

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
        await redis.set('activeMissions', activeMissions);
      }
    }
  }

  await broadcastSSE({ action: 'UPDATE_ALL' });
  res.json({ success: true });
});

// 5. 派遣端發送訊息 API
app.post('/api/missions/chat', async (req, res) => {
  const { missionId, message } = req.body;
  const nowStr = getTimeToMinute();

  let activeMissions = (await redis.get('activeMissions')) || [];
  const targetMission = activeMissions.find(m => m.id === Number(missionId));
  if (targetMission && message) {
    targetMission.chatMessages.push({
      sender: '派遣端',
      role: 'admin',
      text: message,
      time: nowStr
    });
    await redis.set('activeMissions', activeMissions);
    await broadcastSSE({ action: 'UPDATE_ALL' });
  }

  res.json({ success: true });
});

// 6. 單獨結案 API
app.post('/api/missions/close-single', async (req, res) => {
  const { id } = req.body;
  let activeMissions = (await redis.get('activeMissions')) || [];
  const mission = activeMissions.find(m => m.id === id);
  if (mission) {
    mission.status = '已結案';
    mission.closedAt = getTimeToMinute();
    await redis.set('activeMissions', activeMissions);
  }
  await broadcastSSE({ action: 'UPDATE_ALL' });
  res.json({ success: true });
});

// 7. 單獨刪除案件 API
app.post('/api/missions/delete-single', async (req, res) => {
  const { id } = req.body;
  let activeMissions = (await redis.get('activeMissions')) || [];
  activeMissions = activeMissions.filter(m => m.id !== id);
  await redis.set('activeMissions', activeMissions);

  await broadcastSSE({ action: 'UPDATE_ALL' });
  res.json({ success: true });
});

// 8. 清除所有記錄 API
app.post('/api/missions/clear', async (req, res) => {
  await redis.set('activeMissions', []);
  await broadcastSSE({ action: 'UPDATE_ALL' });
  res.json({ success: true });
});

// 9. 地點管理 API
app.get('/api/locations', async (req, res) => {
  const customLocations = (await redis.get('customLocations')) || DEFAULT_LOCATIONS;
  res.json(customLocations);
});

app.post('/api/locations', async (req, res) => {
  const { location } = req.body;
  let customLocations = (await redis.get('customLocations')) || DEFAULT_LOCATIONS;
  if (location && typeof location === 'string' && !customLocations.includes(location.trim())) {
    customLocations.push(location.trim());
    await redis.set('customLocations', customLocations);
  }
  await broadcastSSE({ action: 'LOCATION_UPDATE' });
  res.json(customLocations);
});

app.delete('/api/locations', async (req, res) => {
  const { location } = req.body;
  let customLocations = (await redis.get('customLocations')) || DEFAULT_LOCATIONS;
  customLocations = customLocations.filter(loc => loc !== location);
  await redis.set('customLocations', customLocations);

  await broadcastSSE({ action: 'LOCATION_UPDATE' });
  res.json(customLocations);
});

// 10. SSE 連線 API
app.get('/api/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const clientId = Date.now();
  sseClients.push({ id: clientId, res });

  const systemData = await getSystemData();
  res.write(`data: ${JSON.stringify({ action: 'INIT', ...systemData })}\n\n`);

  req.on('close', () => {
    sseClients = sseClients.filter(client => client.id !== clientId);
  });
});

// 11. 手動刪除成員 API
app.post('/api/student/remove', async (req, res) => {
  const { name } = req.body;
  if (name) {
    let studentStatus = (await redis.get('studentStatus')) || {};
    delete studentStatus[name];
    await redis.set('studentStatus', studentStatus);

    let subscriptions = (await redis.get('subscriptions')) || [];
    subscriptions = subscriptions.filter(sub => sub.name !== name);
    await redis.set('subscriptions', subscriptions);

    await broadcastSSE({ action: 'REMOVE_STUDENT', removedName: name });
    return res.json({ success: true, studentStatus });
  }
  res.json({ success: true });
});

// 12. Ping
setInterval(() => {
  sseClients.forEach(client => {
    try {
      client.res.write(': ping\n\n');
    } catch (e) {}
  });
}, 45000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`派遣系統已於 http://localhost:${PORT} 啟動`));