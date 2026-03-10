const { Telegraf } = require('telegraf');
const axios = require('axios');
const express = require('express');
const { initializeApp, getApps, getApp } = require('firebase/app');
const {
    getFirestore, doc, setDoc, getDocs,
    collection, getDoc, deleteDoc
} = require('firebase/firestore');

// --- Configuration (FIXED SYNTAX) ---
const BOT_TOKEN = '8750794791:AAF8kgmUbgonYgbghYazDhASizoNX0PFhWE';
const CHANNEL_ID = '-1003233643738'; // Removed 'in' to make it valid
const MAX_HISTORY = 20000;

const firebaseConfig = {
  apiKey: "AIzaSyDwc1YILR9mGbwVliAU6uBBPQCqEVTUS7o",
  authDomain: "my-prediction-bot.firebaseapp.com",
  projectId: "my-prediction-bot",
  storageBucket: "my-prediction-bot.firebasestorage.app",
  messagingSenderId: "455075620861",
  appId: "1:455075620861:web:8a414f39fac3350627db94",
  measurementId: "G-1FGESN598R"
};

const firebaseApp = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const db = getFirestore(firebaseApp);
const bot = new Telegraf(BOT_TOKEN);

/**
 * API Data Fetching (FIXED SOURCE ARRAY & PROXY LOGIC)
 */
async function fetchSafeData() {
    const url = "https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json?pageSize=10";
    const proxies = [
        "https://api.codetabs.com/v1/proxy?quest=",
        "https://api.allorigins.win/raw?url=",
        "https://corsproxy.io/?"
    ];

    for (let pBase of proxies) {
        try {
            const fullUrl = `${pBase}${encodeURIComponent(url)}`;
            const res = await axios.get(fullUrl, { timeout: 10000 });
            
            // Checking common API response structures
            const list = res.data?.data?.list || res.data?.list || res.data;
            if (Array.isArray(list)) return list;
        } catch (e) {
            console.log("Proxy failed, trying next...");
        }
    }
    return null;
}

/**
 * Pattern Match AI (L9 to L2)
 */
function getAIPrediction(currentSeq, fullHistory) {
    if (!fullHistory || fullHistory.length < 12) return { r: "BIG", l: "INIT", n: "?" };
    const winHistory = fullHistory.map(h => parseInt(h.number));

    for (let len = 9; len >= 2; len--) {
        const patternToSearch = currentSeq.slice(0, len);
        for (let i = 1; i <= winHistory.length - len - 1; i++) {
            const window = winHistory.slice(i, i + len);
            const isMatch = window.every((val, idx) => val === patternToSearch[idx]);
            if (isMatch) {
                const predNum = winHistory[i - 1];
                return { r: predNum >= 5 ? "BIG" : "SMALL", n: predNum, l: len };
            }
        }
    }
    return { r: Math.random() > 0.5 ? "BIG" : "SMALL", l: "SCAN", n: "?" };
}

async function loop() {
    try {
        const list = await fetchSafeData();
        if (!list || list.length === 0) return;

        // Sync Data
        for (let item of list) {
            const id = (item.issueNumber || item.period || item.issue)?.toString();
            const num = parseInt(item.number || item.result);
            if (!id || isNaN(num)) continue;
            await setDoc(doc(db, 'history_v3', id), { issueNumber: id, number: num, timestamp: Date.now() }, { merge: true });
        }

        const snap = await getDocs(collection(db, 'history_v3'));
        let history = [];
        snap.forEach(d => history.push(d.data()));
        history.sort((a, b) => Number(b.issueNumber) - Number(a.issueNumber));

        if (history.length === 0) return;

        // Cleanup
        if (history.length > MAX_HISTORY) {
            const toDel = history.slice(MAX_HISTORY, MAX_HISTORY + 20);
            for (let old of toDel) await deleteDoc(doc(db, 'history_v3', old.issueNumber));
        }

        const latest = history[0];
        const nextPeriodId = (BigInt(latest.issueNumber) + 1n).toString();
        
        const stateRef = doc(db, 'system', 'state_v3');
        const stateSnap = await getDoc(stateRef);
        const state = stateSnap.exists() ? stateSnap.data() : { issueNumber: "0", done: true };

        // 1. Result Update
        if (state.issueNumber === latest.issueNumber && !state.done) {
            const actual = latest.number >= 5 ? "BIG" : "SMALL";
            const won = state.prediction === actual;
            const resMsg = `📊 *AI RESULT UPDATE*\n━━━━━━━━━━━━━━\n🆔 *PERIOD:* \`#${latest.issueNumber.slice(-4)}\`\n🎲 *PREDICTION:* ${state.prediction}\n🎯 *RESULT:* ${actual} (${latest.number})\n🏆 *STATUS:* ${won ? "✅ WIN" : "❌ LOSS"}\n✨ *RISK LEVEL:* L-${state.level || '?'}`;
            
            try {
                await bot.telegram.editMessageText(CHANNEL_ID, state.msgId, null, resMsg, { parse_mode: 'Markdown' });
                await setDoc(stateRef, { done: true }, { merge: true });
            } catch (e) { console.log("Edit failed"); }
        }

        // 2. New Prediction
        if (state.issueNumber !== nextPeriodId) {
            const currentSeq = history.slice(0, 10).map(h => h.number);
            const ai = await getAIPrediction(currentSeq, history);
            
            const predText = `🎯 *AI PATTERN PREDICTION*\n━━━━━━━━━━━━━━\n🆔 *PERIOD:* \`#${nextPeriodId.slice(-4)}\`\n🎲 *PREDICTION:* **${ai.r}**\n🌪️ *RISK LEVEL:* L-${ai.l}\n🎰 *PREDICTION NO:* ${ai.n}\n🔦 *SCAN HISTORY:* \`${history.length}\` / 20K\n━━━━━━━━━━━━━━`;
            
            try {
                const s = await bot.telegram.sendMessage(CHANNEL_ID, predText, { parse_mode: 'Markdown' });
                await setDoc(stateRef, {
                    issueNumber: nextPeriodId,
                    prediction: ai.r,
                    level: ai.l,
                    msgId: s.message_id,
                    done: false
                });
            } catch (e) { console.log("Telegram send failed"); }
        }
    } catch (err) {
        console.error("Loop Error:", err.message);
    }
}

bot.command('history', async (ctx) => {
    try {
        const snap = await getDocs(collection(db, 'history_v3'));
        let h = []; snap.forEach(d => h.push(d.data()));
        h.sort((a, b) => Number(b.issueNumber) - Number(a.issueNumber));
        let res = "📊 *Recent Database Logs*\n\n";
        h.slice(0, 15).forEach(i => {
            res += `\`#${i.issueNumber.slice(-4)}\` -> ${i.number} (${i.number >= 5 ? "B" : "S"})\n`;
        });
        ctx.replyWithMarkdown(res);
    } catch (e) { ctx.reply("Error fetching history."); }
});

const app = express();
app.get('/', (req, res) => res.send('Bot V3 Fixed Online'));
app.listen(process.env.PORT || 3000);

// Point #16: 25-30 seconds interval is safe
setInterval(loop, 25000);
loop();

bot.launch({ dropPendingUpdates: true });
console.log("Bot Fix Deployed - Monitoring Channel...");
