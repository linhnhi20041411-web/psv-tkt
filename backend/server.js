const express = require('express');
const axios = require('axios');
const cors = require('cors');
const http = require('http'); 
const { Server } = require("socket.io");
const cron = require('node-cron'); // ✅ Bổ sung thư viện Cron
require('dotenv').config();

const app = express();

// --- KHỞI TẠO SERVER & SOCKET ---
const server = http.createServer(app); 
app.use(cors());
const io = new Server(server, {
    cors: { origin: "*" } 
});

// ✅ Giữ nguyên tính năng Stateless (giấu ID vào tin nhắn) tuyệt vời của Sư huynh!
io.on('connection', (socket) => {
    console.log('👤 User Connected:', socket.id);
    
    // ✅ Bổ sung tính năng theo dõi Khách Truy Cập từ Dự án 1
    let rawIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    const userIp = rawIp.split(',')[0].trim();
    trackAndNotifyNewUser(userIp, "Website");
});

const PORT = process.env.PORT || 3001;
app.use(express.json({ limit: '1mb' })); // Hạ xuống 1MB để bảo mật, chống DoS

// --- CẤU HÌNH ---
const rawKeys = process.env.GEMINI_API_KEYS || "";
const apiKeys = rawKeys.split(',').map(key => key.trim()).filter(key => key.length > 0);
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || ""; 
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const GHOST_API_URL = process.env.GHOST_API_URL || "";
const GHOST_CONTENT_API_KEY = process.env.GHOST_CONTENT_API_KEY || "";

// --- TỪ ĐIỂN VIẾT TẮT ---
const TU_DIEN_VIET_TAT = {
    "pmtl": "Pháp Môn Tâm Linh", 
    "btpp": "Bạch Thoại Phật Pháp", 
    "nnn": "Ngôi nhà nhỏ",
    "kvtt": "Kinh Văn Tự Tu",
    "kbt": "Kinh Bài Tập", 
    "psv": "Phụng Sự Viên", 
    "sh": "Sư Huynh",
    "ps": "Phóng Sinh",
    "cđb": "Chú Đại Bi", 
    "cdb": "Chú Đại Bi", 
    "tk": "Tâm Kinh", 
    "lpdshv": "Lễ Phật Đại Sám Hối Văn",
    "vsc": "Vãng Sanh Chú", 
    "cdbstc": "Công Đức Bảo Sơn Thần Chú", 
    "cđbstc": "Công Đức Bảo Sơn Thần Chú",
    "nyblvdln": "Như Ý Bảo Luân Vương Đà La Ni", 
    "bkcn": "Bổ Khuyết Chân Ngôn", 
    "tpdtcn": "Thất Phật Diệt Tội Chân Ngôn",
    "qalccn": "Quán Âm Linh Cảm Chân Ngôn", 
    "tvltqdqmvtdln": "Thánh Vô Lượng Thọ Quyết Định Quang Minh Vương Đà La Ni",
    "xf": "Xoay pháp", 
    "knt": "Khai Nghiệp Tướng", 
    "ht": "Huyền Trang"
};

function dichVietTat(text) {
    if (!text) return "";
    let processedText = text;
    const keys = Object.keys(TU_DIEN_VIET_TAT).sort((a, b) => b.length - a.length);
    keys.forEach(shortWord => {
        const regex = new RegExp(`\\b${shortWord}\\b`, 'gi');
        processedText = processedText.replace(regex, TU_DIEN_VIET_TAT[shortWord]);
    });
    return processedText;
}

// --- TIỆN ÍCH ---
function getRandomStartIndex() { return Math.floor(Math.random() * apiKeys.length); }
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function escapeHtml(text) {
    if (!text) return "";
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// --- TÍNH NĂNG THỐNG KÊ TRUY CẬP HẰNG NGÀY ---
const dailyUsers = new Set(); 

async function sendTelegramAlert(message) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return; 
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        });
    } catch (error) {
        console.error("Lỗi gửi Telegram:", error.message);
    }
}

async function trackAndNotifyNewUser(userId, platform) {
    if (!userId) return;
    if (!dailyUsers.has(userId)) {
        dailyUsers.add(userId); 
        const totalToday = dailyUsers.size;
        
        const msg = `🔔 <b>CÓ KHÁCH MỚI TRUY CẬP!</b>\n` +
                    `🌐 Nền tảng: ${platform}\n` +
                    `👤 ID/IP: <code>${userId}</code>\n` +
                    `📈 <b>Tổng số khách hôm nay: ${totalToday} người</b>`;
                    
        await sendTelegramAlert(`🤖 <b>PSV Khai Thị</b> 🚨\n\n${msg}`);
    }
}

// --- HÀM TÌM KIẾM GHOST CMS ---
async function searchGhost(query) {
    const cleanApiUrl = String(GHOST_API_URL).trim().replace(/\/$/, "");
    const cleanApiKey = String(GHOST_CONTENT_API_KEY).trim();
    const cleanQuery = String(query || "").trim().toLowerCase();

    try {
        const apiUrl = `${cleanApiUrl}/ghost/api/content/posts/?key=${cleanApiKey}&limit=all&formats=plaintext&fields=id,title,url,plaintext`;
        const response = await axios.get(apiUrl, { timeout: 30000 });
        const posts = response.data?.posts || [];

        const keywords = cleanQuery.split(/\s+/).filter(word => word.length > 0);

        const scoredPosts = posts.map(post => {
            const title = (post.title || "").toLowerCase();
            const content = (post.plaintext || "").toLowerCase();
            let score = 0;

            if (title.includes(cleanQuery)) score += 50;
            if (content.includes(cleanQuery)) score += 20;

            keywords.forEach(kw => {
                if (title.includes(kw)) score += 5; 
                if (content.includes(kw)) score += 1; 
            });

            return { ...post, score };
        });

        const matchedPosts = scoredPosts
            .filter(post => post.score > 3)
            .sort((a, b) => b.score - a.score);

        return matchedPosts.slice(0, 5).map(post => ({
            title: post.title,
            url: post.url,
            content: post.plaintext ? post.plaintext.substring(0, 2000) : ""
        }));
    } catch (error) {
        console.error("Lỗi Ghost API:", error.message);
        return [];
    }
}

async function searchGhostTags(query) {
    const cleanApiUrl = String(GHOST_API_URL).trim().replace(/\/$/, "");
    const cleanApiKey = String(GHOST_CONTENT_API_KEY).trim();
    const cleanQuery = String(query || "").trim().toLowerCase();

    try {
        const apiUrl = `${cleanApiUrl}/ghost/api/content/tags/?key=${cleanApiKey}&limit=all`;
        const response = await axios.get(apiUrl, { timeout: 15000 });
        const tags = response.data?.tags || [];

        const matchedTags = tags.filter(tag => {
            const tagName = (tag.name || "").toLowerCase();
            return tagName.length > 2 && cleanQuery.includes(tagName);
        });

        return matchedTags.map(tag => ({
            name: tag.name,
            url: tag.url 
        }));
    } catch (error) {
        console.error("Lỗi Ghost Tags API:", error.message);
        return [];
    }
}

// --- GỌI GEMINI (ĐÃ VÁ LỖI TIMEOUT NHƯ DỰ ÁN 1) ---
async function callGeminiWithRetry(payload, keyIndex = 0, retryCount = 0, modelName = "gemini-2.5-flash-lite") {
    if (keyIndex >= apiKeys.length) {
        if (retryCount < 1) { 
            await sleep(2000);
            return callGeminiWithRetry(payload, 0, retryCount + 1, modelName);
        }
        await sendTelegramAlert(`🤖 <b>PSV Khai Thị</b> 🚨\n\n🆘 HẾT SẠCH API KEY! Hệ thống không thể phản hồi.`);
        throw new Error("ALL_KEYS_EXHAUSTED");
    }
    
    const currentKey = apiKeys[keyIndex];
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${currentKey}`;
    
    try {
        // Tăng timeout lên 90s để chống đứt gánh
        return await axios.post(apiUrl, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 90000 });
    } catch (error) {
        const status = error.response ? error.response.status : 0;
        const isTimeout = error.code === 'ECONNABORTED' || error.message.includes('timeout');

        if (isTimeout || [429, 400, 403, 500, 503].includes(status)) {
            console.warn(`⚠️ Key ${keyIndex} lỗi. Đổi Key...`);
            await sleep(Math.floor(Math.random() * 2000) + 1000); 
            return callGeminiWithRetry(payload, keyIndex + 1, retryCount, modelName);
        }
        throw error;
    }
}

// --- API CHAT CHÍNH ---
app.post('/api/chat', async (req, res) => {
    try {
        const { question, socketId } = req.body; 
        if (!question) return res.status(400).json({ error: 'Thiếu câu hỏi.' });

        if (question.trim().toLowerCase().startsWith("@psv")) {
            const parts = question.split(':');
            const msgContent = parts.length >= 2 ? parts.slice(1).join(':').trim() : "";
            const safeMsg = escapeHtml(msgContent || "Sư huynh gõ lệnh @psv nhưng chưa nhập nội dung.");
            
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                chat_id: TELEGRAM_CHAT_ID,
                text: `📨 <b>TIN NHẮN TRỰC TIẾP</b>\n\n"${safeMsg}"\n\n👉 <i>Admin hãy Reply để trả lời.</i>\n\n<code>#id_${socketId}</code>`,
                parse_mode: 'HTML'
            });
            return res.json({ answer: "✅ Đệ đã chuyển tin nhắn riêng tới Ban quản trị ạ! 🙏" });
        }

        const fullQuestion = dichVietTat(question);
        const [documents, matchedTags] = await Promise.all([
            searchGhost(fullQuestion),
            searchGhostTags(fullQuestion)
        ]);

        const HEADER_MSG = "Đệ chào Sư huynh, dưới đây là thông tin đệ tìm được ạ:\n\n";
        const FOOTER_MSG = "\n\nSư huynh cần đệ giúp gì xin cứ đặt câu hỏi nhé!";

        let TAG_MSG = "";
        if (matchedTags && matchedTags.length > 0) {
            if (matchedTags.length === 1) {
                TAG_MSG = `📚 **Chuyên đề liên quan:** Đệ thấy Sư huynh đang quan tâm đến chủ đề **${matchedTags[0].name}**. Sư huynh có thể xem tổng hợp toàn bộ bài viết tại đây nhé:\n👉 Link: ${matchedTags[0].url}\n\n---\n\n`;
            } else {
                TAG_MSG = `📚 **Các chuyên đề liên quan:** Đệ thấy câu hỏi của Sư huynh liên quan đến nhiều chủ đề. Sư huynh có thể xem tổng hợp các bài viết theo từng chuyên đề dưới đây nhé:\n`;
                matchedTags.forEach(tag => {
                    TAG_MSG += `👉 **${tag.name}**: ${tag.url}\n`;
                });
                TAG_MSG += `\n---\n\n`;
            }
        }
        
        if ((!documents || documents.length === 0) && matchedTags.length === 0) {
            const safeUserQ = escapeHtml(question);
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                chat_id: TELEGRAM_CHAT_ID,
                text: `❓ <b>KHÔNG TÌM THẤY DỮ LIỆU</b>\nUser hỏi: "${safeUserQ}"\n\n👉 <i>Sư huynh hãy Reply để hỗ trợ trực tiếp.</i>\n\n<code>#id_${socketId}</code>`,
                parse_mode: 'HTML'
            });
            return res.json({ 
                answer: "Đệ tìm trong dữ liệu không thấy thông tin này. Đệ đã chuyển câu hỏi đến Ban Quản Trị để được hỗ trợ thêm. Sư huynh vui lòng giữ kết nối nhé ạ! 🙏" 
            });
        }

        if (!documents || documents.length === 0) {
            return res.json({ answer: HEADER_MSG + TAG_MSG + FOOTER_MSG });
        }

        let contextString = "";
        documents.forEach((doc, index) => {
            contextString += `Bài #${index + 1}: ${doc.title}\nLink: ${doc.url}\nNội dung: ${doc.content.substring(0, 2000)}\n\n`;
        });
        
        const systemPrompt = `
            Bối cảnh: Bạn là một trợ lý trích lục dữ liệu trung thực.
            Dữ liệu nguồn (Context): ${contextString}
            NHIỆM VỤ: Trích xuất thông tin cho câu hỏi: "${fullQuestion}".

            QUY TẮC:
            1. TRUNG THỰC TUYỆT ĐỐI: Chỉ dùng "Dữ liệu nguồn". KHÔNG tự viết lại, KHÔNG diễn giải.
            2. TRÍCH DẪN NGUYÊN VĂN đoạn văn quan trọng.
            3. ĐỊNH DẠNG:
               - [Tên bài viết]
               [Đoạn trích nguyên văn]
               https://www.thegioididong.com/hoi-dap/cach-tao-lien-ket-link-trong-microsoft-word-don-gian-1343271
            4. KHÔNG chào hỏi/kết luận. Nếu không khớp trả về: NO_DATA
        `;

        let response = await callGeminiWithRetry(
            { 
                contents: [{ parts: [{ text: systemPrompt }] }],
                generationConfig: { temperature: 0.1 }
            }, 
            getRandomStartIndex()
        );
        
        let aiBody = "";
        let finishReason = response.data?.candidates?.[0]?.finishReason || "";

        if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
            aiBody = response.data.candidates[0].content.parts[0].text.trim();
        }

        // ✅ CỨU NGUY BẢN QUYỀN (RECITATION / SAFETY)
        if (finishReason === "RECITATION" || finishReason === "SAFETY" || (!aiBody && finishReason !== "STOP")) {
            console.log(`⚠️ Bị chặn (Lỗi: ${finishReason}). Dùng Prompt diễn giải...`);
            const promptDienGiai = `NV: Trả lời câu hỏi "${fullQuestion}" dựa trên dữ liệu nguồn. QUY TẮC TUYỆT ĐỐI: CHỈ dùng thông tin trong dữ liệu nguồn. Viết tóm tắt ngắn gọn lại bằng lời của bạn để tránh lỗi bản quyền. Nếu không có thông tin, trả lời NO_DATA.\n\nDữ liệu: ${contextString}`;
            
            response = await callGeminiWithRetry({
                contents: [{ parts: [{ text: promptDienGiai }] }],
                generationConfig: { temperature: 0.1 }
            }, getRandomStartIndex());

            if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                aiBody = response.data.candidates[0].content.parts[0].text.trim();
            } else {
                aiBody = "NO_DATA";
            }
        }

        if (aiBody.includes("NO_DATA") || aiBody.length < 5) {
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                chat_id: TELEGRAM_CHAT_ID,
                text: `❓ <b>AI KHÔNG THỂ TRÍCH DẪN NGUYÊN VĂN</b>\nUser: "${escapeHtml(question)}"\n\n<code>#id_${socketId}</code>`,
                parse_mode: 'HTML'
            });

            let suggestMsg = "Đệ chưa tìm được đoạn trích dẫn nguyên văn sát với câu hỏi. Tuy nhiên đệ thấy có các bài viết liên quan sau đây, Sư huynh bấm vào link để đọc tham khảo nhé ạ:\n\n";
            documents.forEach((doc, index) => {
                suggestMsg += `* [${doc.title}]\nLink: ${doc.url}\n\n`;
            });

            return res.json({ answer: HEADER_MSG + TAG_MSG + suggestMsg + FOOTER_MSG });
        }

        res.json({ answer: HEADER_MSG + TAG_MSG + aiBody + FOOTER_MSG });
    } catch (error) {
        console.error("Lỗi:", error.message);
        res.status(500).json({ error: "Lỗi hệ thống." });
    }
});

// --- API WEBHOOK: ADMIN REPLY TỪ TELEGRAM ---
app.post(`/api/telegram-webhook/${process.env.TELEGRAM_TOKEN}`, async (req, res) => {
    try {
        const { message } = req.body;
        
        const isAdminChat = message && message.chat && message.chat.id.toString() === process.env.TELEGRAM_CHAT_ID;
        // Báo cáo nếu khách nhắn Telegram trực tiếp tới Bot
        if (!isAdminChat && message && message.from && message.from.id) {
             trackAndNotifyNewUser(message.from.id, "Telegram");
        }

        if (message && message.reply_to_message) {
            const originalText = message.reply_to_message.text || message.reply_to_message.caption || "";
            const match = originalText.match(/#id_([a-zA-Z0-9_-]+)/);
            
            if (match && match[1]) {
                const userSocketId = match[1];
                if (message.photo) {
                    const fileId = message.photo[message.photo.length - 1].file_id;
                    const fileInfoRes = await axios.get(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
                    const downloadUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${fileInfoRes.data.result.file_path}`;
                    
                    const imageRes = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
                    // Fix lỗi parse Base64 Buffer
                    const base64Image = Buffer.from(imageRes.data).toString('base64');
                    
                    io.to(userSocketId).emit('admin_reply_image', `data:image/jpeg;base64,${base64Image}`);
                    if (message.caption) io.to(userSocketId).emit('admin_reply', message.caption);
                } else if (message.text) {
                    io.to(userSocketId).emit('admin_reply', message.text);
                }
            }
        }
        res.sendStatus(200);
    } catch (e) {
        console.error("Lỗi Webhook:", e.message);
        res.sendStatus(500);
    }
});

// --- TỰ ĐỘNG CHỐT SỐ LIỆU VÀ RESET LÚC 23:59 MỖI NGÀY ---
cron.schedule('59 23 * * *', async () => {
    const total = dailyUsers.size;
    if (total > 0) {
        const msg = `📊 <b>BÁO CÁO TỔNG KẾT CUỐI NGÀY</b>\n` +
                    `Tổng số lượt khách truy cập hôm nay: <b>${total}</b> người.\n` +
                    `<i>🔄 Hệ thống đã tự động làm mới bộ đếm cho ngày mai!</i>`;
        await sendTelegramAlert(`🤖 <b>PSV Khai Thị</b> 🚨\n\n${msg}`);
    }
    dailyUsers.clear();
}, {
    scheduled: true,
    timezone: "Asia/Ho_Chi_Minh" 
});

app.get('/api/health', (req, res) => res.send("Server Online!"));
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
