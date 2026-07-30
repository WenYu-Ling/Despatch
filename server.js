const express = require('express');
const webpush = require('web-push');
const path = require('path');
const { Redis } = require('@upstash/redis');

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
let cache = {
  activeMissions: null,
  studentStatus: null,
  customLocations: null,
  subscriptions: null
};

// 統一讀取資料
async function getSystemData(forceRefresh = false) {
  if (forceRefresh || !cache.activeMissions || !cache.studentStatus) {
    const [missions, status, locations, subs] = await Promise.all([
      redis.get('activeMissions'),
      redis.get('studentStatus'),
      redis.get('customLocations'),
      redis.get('subscriptions')
    ]);
    cache.activeMissions = missions || [];
    cache.studentStatus = status || {};
    cache.customLocations = locations || DEFAULT_LOCATIONS;
    cache.subscriptions = subs || [];
  }
  return cache;
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
    } catch (err) {}
  });
}

function getTimeToMinute() {
  const now = new Date();
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(now);
}

// 1. VAPID Key API
app.get('/api/vapid-public-key', (req, res) => res.json({ publicKey: publicVapidKey }));

// 2. Push API
app.post('/api/subscribe', async (req, res) => {
  const { subscription, name } = req.body;
  if (subscription && subscription.endpoint && name) {
    const data = await getSystemData();
    let subscriptions = data.subscriptions;
    
    // 檢查是否已經存在相同的 Endpoint
    const exists = subscriptions.some(sub => sub.name === name && sub.endpoint === subscription.endpoint);
    
    if (!exists) {
      subscriptions = subscriptions.filter(sub => sub.name !== name && sub.endpoint !== subscription.endpoint);
      subscriptions.push({ name, ...subscription });
      cache.subscriptions = subscriptions;
      await redis.set('subscriptions', subscriptions); // 只有 Endpoint 改變才寫入 Redis
    }

    if (!data.studentStatus[name] || data.studentStatus[name].status === 'Off Duty') {
      data.studentStatus[name] = {
        status: 'On Duty',
        updatedAt: getTimeToMinute(),
        timestamp: Date.now()
      };
      cache.studentStatus = data.studentStatus;
      await redis.set('studentStatus', data.studentStatus);
      await broadcastSSE({ action: 'UPDATE_ALL' });
    }
  }
  res.status(201).json({ success: true });
});

// 3. 派遣 API
app.post('/api/dispatch', async (req, res) => {
  const { type, location, detail } = req.body;
  if (!type || !location) return res.status(400).json({ success: false, error: 'Type/location required.' });

  const nowStr = getTimeToMinute();
  const mission = {
    id: Date.now(),
    type, location, detail: detail || '',
    status: '派遣中',
    createdAt: nowStr, closedAt: null,
    responseLogs: [], chatMessages: []
  };

  const data = await getSystemData();
  data.activeMissions.unshift(mission);
  cache.activeMissions = data.activeMissions;
  
  await redis.set('activeMissions', data.activeMissions);
  await broadcastSSE({ action: 'UPDATE_ALL' });

  const payload = JSON.stringify({
    title: `【緊急派遣 ${nowStr}】${type}`,
    body: `地點：${location}${detail ? ` (${detail})` : ''}\n請立即確認！`,
    url: '/student.html'
  });

  const targetSubscriptions = data.subscriptions.filter(sub => {
    const statusObj = data.studentStatus[sub.name];
    return !statusObj || statusObj.status !== 'Off Duty';
  });

  Promise.all(
    targetSubscriptions.map(sub =>
      webpush.sendNotification(sub, payload).catch(async err => {
        if (err.statusCode === 404 || err.statusCode === 410) {
          cache.subscriptions = cache.subscriptions.filter(s => s.endpoint !== sub.endpoint);
          await redis.set('subscriptions', cache.subscriptions);
        }
      })
    )
  );

  res.json({ success: true, mission });
});

// 4. 狀態與訊息 API (💡 關鍵優化：狀態沒變時不寫入 Redis)
app.post('/api/student/status', async (req, res) => {
  const { name, status, missionId, reportText } = req.body;
  if (!name || !status) return res.status(400).json({ success: false, error: 'Missing fields.' });

  const nowStr = getTimeToMinute();
  const data = await getSystemData();
  let hasChanged = false;

  if (status === '現場訊息') {
    if (missionId) {
      const targetMission = data.activeMissions.find(m => m.id === Number(missionId));
      if (targetMission) {
        targetMission.chatMessages.push({ sender: name, role: 'student', text: reportText || '', time: nowStr });
        await redis.set('activeMissions', data.activeMissions);
        hasChanged = true;
      }
    }
  } else {
    const newStatus = (status === 'Off Duty') ? 'Off Duty' : 'On Duty';
    const currentObj = data.studentStatus[name];

    // 只有在狀態改變時才寫入 Redis；如果本來就是 On Duty (心跳包)，直接跳過寫入！
    if (!currentObj || currentObj.status !== newStatus) {
      data.studentStatus[name] = { status: newStatus, updatedAt: nowStr, timestamp: Date.now() };
      cache.studentStatus = data.studentStatus;
      await redis.set('studentStatus', data.studentStatus);
      hasChanged = true;
    }

    if (missionId) {
      const targetMission = data.activeMissions.find(m => m.id === Number(missionId));
      if (targetMission) {
        targetMission.responseLogs.push({ id: Date.now(), name, status, time: nowStr });
        if (status === '已接案' && targetMission.status === '派遣中') targetMission.status = '已接案';
        else if (status === '已到場') targetMission.status = '已到場';
        await redis.set('activeMissions', data.activeMissions);
        hasChanged = true;
      }
    }
  }

  if (hasChanged) await broadcastSSE({ action: 'UPDATE_ALL' });
  res.json({ success: true });
});

// 5. 派遣端訊息 API
app.post('/api/missions/chat', async (req, res) => {
  const { missionId, message } = req.body;
  const data = await getSystemData();
  const targetMission = data.activeMissions.find(m => m.id === Number(missionId));
  if (targetMission && message) {
    targetMission.chatMessages.push({ sender: '派遣端', role: 'admin', text: message, time: getTimeToMinute() });
    await redis.set('activeMissions', data.activeMissions);
    await broadcastSSE({ action: 'UPDATE_ALL' });
  }
  res.json({ success: true });
});

// 6~8. 結案與刪除 API
app.post('/api/missions/close-single', async (req, res) => {
  const data = await getSystemData();
  const mission = data.activeMissions.find(m => m.id === req.body.id);
  if (mission) {
    mission.status = '已結案';
    mission.closedAt = getTimeToMinute();
    await redis.set('activeMissions', data.activeMissions);
    await broadcastSSE({ action: 'UPDATE_ALL' });
  }
  res.json({ success: true });
});

app.post('/api/missions/delete-single', async (req, res) => {
  const data = await getSystemData();
  cache.activeMissions = data.activeMissions.filter(m => m.id !== req.body.id);
  await redis.set('activeMissions', cache.activeMissions);
  await broadcastSSE({ action: 'UPDATE_ALL' });
  res.json({ success: true });
});

app.post('/api/missions/clear', async (req, res) => {
  cache.activeMissions = [];
  await redis.set('activeMissions', []);
  await broadcastSSE({ action: 'UPDATE_ALL' });
  res.json({ success: true });
});

// 9. 地點 API
app.get('/api/locations', async (req, res) => {
  const data = await getSystemData();
  res.json(data.customLocations);
});

// 10. SSE 連線 API
app.get('/api/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const clientId = Date.now();
  sseClients.push({ id: clientId, res });

  // 強制重新載入最新資料給新開啟的頁面
  const data = await getSystemData(true);
  res.write(`data: ${JSON.stringify({ action: 'INIT', ...data })}\n\n`);

  req.on('close', () => {
    sseClients = sseClients.filter(client => client.id !== clientId);
  });
});

// 11. 手動刪除/關閉成員 API
// 手動刪除/關閉成員 API
app.post('/api/student/remove', async (req, res) => {
  const { name } = req.body;
  if (name) {
    const data = await getSystemData();
    
    if (data.studentStatus[name]) {
      // ⚡ 關鍵修復：
      // 如果對方已經是 Off Duty，按 ✕ 就是要「完全剔除名單」
      if (data.studentStatus[name].status === 'Off Duty') {
        delete data.studentStatus[name]; // 徹底從物件中刪除 Key
      } else {
        // 如果對方是 On Duty，按 ✕ 是強制把他切換成 Off Duty
        data.studentStatus[name].status = 'Off Duty';
        data.studentStatus[name].updatedAt = getTimeToMinute();
      }
    }
    
    // 尋找該成員的 Web Push 訂閱資料並發送通知
    const targetSub = data.subscriptions.find(sub => sub.name === name);
    if (targetSub) {
      const payload = JSON.stringify({
        title: '【勤務狀態變更】',
        body: '派遣端已手動更新您的勤務狀態。',
        url: '/student.html'
      });
      webpush.sendNotification(targetSub, payload).catch(err => console.log('Push error:', err));
    }

    // 更新 Redis 與 快取
    await Promise.all([
      redis.set('studentStatus', data.studentStatus),
      redis.set('subscriptions', data.subscriptions)
    ]);

    // ⚡ 發送 SSE 廣播給所有派遣端與手機，同步更新動態牆
    await broadcastSSE({ 
      action: 'REMOVE_STUDENT', 
      removedName: name,
      studentStatus: data.studentStatus
    });

    return res.json({ success: true, studentStatus: data.studentStatus });
  }
  
  res.json({ success: false });
});

// 12. 心跳 Ping
setInterval(() => {
  sseClients.forEach(client => {
    try { client.res.write(': ping\n\n'); } catch (e) {}
  });
}, 45000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`派遣系統已於 http://localhost:${PORT} 啟動`));