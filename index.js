const { Telegraf } = require('telegraf');
const axios = require('axios');
const express = require('express');
const { initializeApp, getApps, getApp } = require('firebase/app');
const {
    getFirestore, doc, setDoc, getDocs,
    collection, getDoc, deleteDoc
} = require('firebase/firestore');

// --- Configuration ---
const BOT_TOKEN = '8750794791:AAGtp1GrVnwZP0EXbMA3lW1lpBVU3whTY98';
const CHANNEL_ID = '-1003233643738'; 
const RENDER_EXTERNAL_URL = "https://prediction-botb.onrender.com"; 

const firebaseConfig = {
  apiKey: "AIzaSyDwc1YILR9mGbwVliAU6uBBPQCqEVTUS7o",
  authDomain: "my-prediction-bot.firebaseapp.com",
  projectId: "my-prediction-bot",
  storageBucket: "my-prediction-bot.firebasestorage.app",
  messagingSenderId: "455075620861",
  appId: "1:455075620861:web:8a414f39fac3350627db94"
};

const firebaseApp = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const db = getFirestore(firebaseApp);
const bot = new Telegraf(BOT_TOKEN);

/**
 * Super-Fast API Fetcher
 */
async function fetchSafeData() {
    const url = "https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json?pageSize=20";
    try {
        // Direct attempt with no proxy first for speed
        const res = await axios.get(url, { timeout: 5000 });
        const list = res.data?.data?.list || res.data?.list;
        if (Array.isArray(list)) return list;
    } catch (e) {
        // Proxy Fallback if direct fails
        try {
            const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
            const res = await axios.get(proxyUrl, { timeout: 8000 });
            const list = res.data?.data?.list || res.data?.list;
            if (Array.isArray(list)) return list;
        } catch (err) { return null; }
    }
}

/**
 * AI Logic
 */
function getAIPrediction(currentSeq, fullHistory) {
    const winHistory = fullHistory.map(h => parseInt(h.number));
    for (let len = 9; len >= 2; len--) {
        const pattern = currentSeq.slice(0, len);
        for (let i = 1; i <= winHistory.length - len - 1; i++) {
            const window = winHistory.slice(i, i + len);
            if (window.every((val, idx) => val === pattern[idx])) {
                return { r: winHistory[i - 1] >= 5 ? "BIG" : "SMALL", l: len, n: winHistory[i - 1] };
            }
        }
    }
    const last5 = currentSeq.slice(0, 5);
    const bigs = last5.filter(n => n >= 5).length;
    return { r: bigs >= 3 ? "BIG" : "SMALL", l: "AUTO", n: "?" };
}

async function loop() {
    try {
        const list = await fetchSafeData();
        if (!list) return;

        // Syncing 
        for (let item of list) {
            const id = (item.issueNumber || item.period)?.toString();
            const num = parseInt(item.number || item.result);
            if (id && !isNaN(num)) {
                await setDoc(doc(db, 'history_v3', id), { issueNumber: id, number: num }, { merge: true });
            }
        }

        const snap = await getDocs(collection(db, 'history_v3'));
        let history = [];
        snap.forEach(d => history.push(d.data()));
        history.sort((a, b) => Number(b.issueNumber) - Number(a.issueNumber));
        if (history.length === 0) return;

        const latest = history[0];
        const nextPeriodId = (BigInt(latest.issueNumber) + 1n).toString();
        
        const stateRef = doc(db, 'system', 'state_v3');
        const stateSnap = await getDoc(stateRef);
        const state = stateSnap.exists() ? stateSnap.data() : { issueNumber: "0", done: true };

        // 1. EDITING LOGIC (Aggressive)
        if (state.issueNumber === latest.issueNumber && !state.done) {
            const actual = latest.number >= 5 ? "BIG" : "SMALL";
            const isWin = state.prediction === actual;
            const resText = `📊 *AI RESULT UPDATE*\n━━━━━━━━━━━━━━\n🆔 *PERIOD:* \`#${latest.issueNumber.slice(-4)}\`\n🎲 *PRED:* ${state.prediction}\n🎯 *RESULT:* ${actual} (${latest.number})\n🏆 *STATUS:* ${isWin ? "✅ WIN" : "❌ LOSS"}\n✨ *MATCH:* L-${state.level}`;
            
            try {
                await bot.telegram.editMessageText(CHANNEL_ID, state.msgId, null, resText, { parse_mode: 'Markdown' });
                await setDoc(stateRef, { done: true }, { merge: true });
                console.log("✅ Result Updated");
            } catch (e) { 
                console.log("❌ Edit Failed"); 
                await setDoc(stateRef, { done: true }, { merge: true });
            }
        }

        // 2. NEW PREDICTION
        if (state.issueNumber !== nextPeriodId) {
            const currentSeq = history.slice(0, 10).map(h => h.number);
            const ai = await getAIPrediction(currentSeq, history);
            const predMsg = `🎯 *AI PATTERN PREDICTION*\n━━━━━━━━━━━━━━\n🆔 *PERIOD:* \`#${nextPeriodId.slice(-4)}\`\n🎲 *PREDICTION:* **${ai.r}**\n🌪️ *MATCH:* L-${ai.l}\n🎰 *NUMBER:* ${ai.n}\n⏳ *HISTORY:* \`${history.length}\` / 15K\n━━━━━━━━━━━━━━`;
            
            try {
                const s = await bot.telegram.sendMessage(CHANNEL_ID, predMsg, { parse_mode: 'Markdown' });
                await setDoc(stateRef, {
                    issueNumber: nextPeriodId,
                    prediction: ai.r,
                    level: ai.l,
                    msgId: s.message_id,
                    done: false
                });
                console.log("🚀 Prediction Sent");
            } catch (e) { console.log("❌ Send Failed"); }
        }

    } catch (err) { console.log("Loop Error:", err.message); }
}

const app = express();
app.get('/', (req, res) => res.send('Bot Alive'));
app.listen(process.env.PORT || 3000);

// --- Prevent Render Sleep (PINGER) ---
setInterval(() => {
    axios.get(RENDER_EXTERNAL_URL).catch(() => {});
    console.log("Pinged self to stay awake...");
}, 240000); // Har 4 minute me ping

setInterval(loop, 12000); // Har 12 second me check (Fast)
loop();

bot.launch({ dropPendingUpdates: true });
