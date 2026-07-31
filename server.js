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

let statusUpdateQueue = Promise.resolve();

function generateUniqueId() {
  return `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
}

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

app.get('/api/vapid-public-key', (req, res) => res.json({ publicKey: publicVapidKey }));

app.post('/api/subscribe', async (req, res) => {
  const { subscription, name } = req.body;
  if (subscription && subscription.endpoint && name) {
    const data = await getSystemData(true);
    let subscriptions = data.subscriptions;
    
    const exists = subscriptions.some(sub => sub.name === name && sub.endpoint === subscription.endpoint);
    
    if (!exists) {
      subscriptions = subscriptions.filter(sub => sub.name !== name && sub.endpoint !== subscription.endpoint);
      subscriptions.push({ name, ...subscription });
      cache.subscriptions = subscriptions;
      await redis.set('subscriptions', subscriptions);
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

  statusUpdateQueue = statusUpdateQueue.then(async () => {
    const data = await getSystemData(true);
    data.activeMissions.unshift(mission);
    cache.activeMissions = data.activeMissions;
    await redis.set('activeMissions', data.activeMissions);
    await broadcastSSE({ action: 'UPDATE_ALL' });
  });

  await statusUpdateQueue;

  const payload = JSON.stringify({
    title: `【緊急派遣 ${nowStr}】${type}`,
    body: `地點：${location}${detail ? ` (${detail})` : ''}\n請立即確認！`,
    url: '/student.html'
  });

  const data = await getSystemData();
  const targetSubscriptions = data.subscriptions.filter(sub => {
    const statusObj = data.studentStatus[sub.name];
    return statusObj && statusObj.status !== 'Off Duty';
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

app.post('/api/student/status', async (req, res) => {
  const { name, status, missionId, reportText } = req.body;
  if (!name || !status) return res.status(400).json({ success: false, error: 'Missing fields.' });

  const nowStr = getTimeToMinute();

  statusUpdateQueue = statusUpdateQueue.then(async () => {
    const data = await getSystemData(true);
    let hasChanged = false;

    if (status === '現場訊息') {
      if (missionId) {
        const targetMission = data.activeMissions.find(m => m.id === Number(missionId));
        if (targetMission) {
          if (!targetMission.chatMessages) targetMission.chatMessages = [];
          targetMission.chatMessages.push({ id: generateUniqueId(), sender: name, role: 'student', text: reportText || '', time: nowStr });
          cache.activeMissions = data.activeMissions;
          await redis.set('activeMissions', data.activeMissions);
          hasChanged = true;
        }
      }
    } else {
      const newStatus = (status === 'Off Duty') ? 'Off Duty' : 'On Duty';
      const currentObj = data.studentStatus[name];

      if (newStatus === 'Off Duty') {
        data.subscriptions = data.subscriptions.filter(sub => sub.name !== name);
        cache.subscriptions = data.subscriptions;
        await redis.set('subscriptions', data.subscriptions);
      }

      if (!currentObj || currentObj.status !== newStatus) {
        data.studentStatus[name] = { status: newStatus, updatedAt: nowStr, timestamp: Date.now() };
        cache.studentStatus = data.studentStatus;
        await redis.set('studentStatus', data.studentStatus);
        hasChanged = true;
      }

      if (missionId) {
        const targetMission = data.activeMissions.find(m => m.id === Number(missionId));
        if (targetMission) {
          if (!targetMission.responseLogs) targetMission.responseLogs = [];

          targetMission.responseLogs.push({ id: generateUniqueId(), name, status, time: nowStr });

          const studentLatestStatus = {};
          targetMission.responseLogs.forEach(l => {
            studentLatestStatus[l.name] = l.status;
          });

          const participants = Object.keys(studentLatestStatus);
          const isAllLeft = participants.length > 0 && participants.every(n => studentLatestStatus[n] === '已離場');

          if (isAllLeft) {
            targetMission.status = '已離場';
          } else if (status === '已到場') {
            targetMission.status = '已到場';
          } else if (status === '已接案' && targetMission.status === '派遣中') {
            targetMission.status = '已接案';
          }
          
          cache.activeMissions = data.activeMissions;
          await redis.set('activeMissions', data.activeMissions);
          hasChanged = true;
        }
      }
    }

    if (hasChanged) await broadcastSSE({ action: 'UPDATE_ALL' });
  });

  await statusUpdateQueue;
  res.json({ success: true });
});

app.post('/api/missions/chat', async (req, res) => {
  const { missionId, message } = req.body;
  
  statusUpdateQueue = statusUpdateQueue.then(async () => {
    const data = await getSystemData(true);
    const targetMission = data.activeMissions.find(m => m.id === Number(missionId));
    if (targetMission && message) {
      if (!targetMission.chatMessages) targetMission.chatMessages = [];
      targetMission.chatMessages.push({ id: generateUniqueId(), sender: '派遣端', role: 'admin', text: message, time: getTimeToMinute() });
      cache.activeMissions = data.activeMissions;
      await redis.set('activeMissions', data.activeMissions);
      await broadcastSSE({ action: 'UPDATE_ALL' });
    }
  });

  await statusUpdateQueue;
  res.json({ success: true });
});

app.post('/api/missions/close-single', async (req, res) => {
  statusUpdateQueue = statusUpdateQueue.then(async () => {
    const data = await getSystemData(true);
    const mission = data.activeMissions.find(m => m.id === req.body.id);
    if (mission) {
      mission.status = '已結案';
      mission.closedAt = getTimeToMinute();
      await redis.set('activeMissions', data.activeMissions);
      await broadcastSSE({ action: 'UPDATE_ALL' });
    }
  });

  await statusUpdateQueue;
  res.json({ success: true });
});

app.post('/api/missions/delete-single', async (req, res) => {
  statusUpdateQueue = statusUpdateQueue.then(async () => {
    const data = await getSystemData(true);
    cache.activeMissions = data.activeMissions.filter(m => m.id !== req.body.id);
    await redis.set('activeMissions', cache.activeMissions);
    await broadcastSSE({ action: 'UPDATE_ALL' });
  });

  await statusUpdateQueue;
  res.json({ success: true });
});

app.post('/api/missions/clear', async (req, res) => {
  statusUpdateQueue = statusUpdateQueue.then(async () => {
    cache.activeMissions = [];
    await redis.set('activeMissions', []);
    await broadcastSSE({ action: 'UPDATE_ALL' });
  });

  await statusUpdateQueue;
  res.json({ success: true });
});

app.get('/api/locations', async (req, res) => {
  const data = await getSystemData();
  res.json(data.customLocations);
});

app.post('/api/locations', async (req, res) => {
  const { location } = req.body;
  if (location) {
    const data = await getSystemData(true);
    if (!data.customLocations.includes(location)) {
      data.customLocations.push(location);
      cache.customLocations = data.customLocations;
      await redis.set('customLocations', data.customLocations);
      await broadcastSSE({ action: 'UPDATE_LOCATIONS' });
    }
  }
  res.json({ success: true });
});

app.delete('/api/locations', async (req, res) => {
  const { location } = req.body;
  if (location) {
    const data = await getSystemData(true);
    data.customLocations = data.customLocations.filter(l => l !== location);
    cache.customLocations = data.customLocations;
    await redis.set('customLocations', data.customLocations);
    await broadcastSSE({ action: 'UPDATE_LOCATIONS' });
  }
  res.json({ success: true });
});

app.get('/api/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const clientId = generateUniqueId();
  sseClients.push({ id: clientId, res });

  const data = await getSystemData(true);
  res.write(`data: ${JSON.stringify({ action: 'INIT', ...data })}\n\n`);

  req.on('close', () => {
    sseClients = sseClients.filter(client => client.id !== clientId);
  });
});

app.post('/api/student/remove', async (req, res) => {
  const { name } = req.body;
  if (name) {
    const data = await getSystemData(true);
    
    if (data.studentStatus[name]) {
      if (data.studentStatus[name].status === 'Off Duty') {
        delete data.studentStatus[name];
        data.subscriptions = data.subscriptions.filter(sub => sub.name !== name);
      } else {
        data.studentStatus[name].status = 'Off Duty';
        data.studentStatus[name].updatedAt = getTimeToMinute();
        data.subscriptions = data.subscriptions.filter(sub => sub.name !== name);
      }
    }
    
    cache.studentStatus = data.studentStatus;
    cache.subscriptions = data.subscriptions;

    await Promise.all([
      redis.set('studentStatus', data.studentStatus),
      redis.set('subscriptions', data.subscriptions)
    ]);

    await broadcastSSE({ 
      action: 'REMOVE_STUDENT', 
      removedName: name,
      studentStatus: data.studentStatus
    });

    return res.json({ success: true, studentStatus: data.studentStatus });
  }
  
  res.json({ success: false });
});

setInterval(() => {
  sseClients.forEach(client => {
    try { client.res.write(': ping\n\n'); } catch (e) {}
  });
}, 45000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`派遣系統已於 http://localhost:${PORT} 啟動`));