const express = require('express');
const axios = require('axios');
const cors = require('cors');
const http = require('http'); 
const { Server } = require("socket.io");
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();

// --- KHỞI TẠO SERVER & SOCKET ---
const server = http.createServer(app); 
app.use(cors());
const io = new Server(server, {
    cors: { origin: "*" } 
});

const pendingRequests = new Map();
const socketToMsgId = new Map();

io.on('connection', (socket) => {
    console.log('👤 User Connected:', socket.id);
    socket.on('disconnect', () => {
        if (socketToMsgId.has(socket.id)) {
            const msgIds = socketToMsgId.get(socket.id);
            if (msgIds) msgIds.forEach(id => pendingRequests.delete(id));
            socketToMsgId.delete(socket.id);
        }
    });
});

const PORT = process.env.PORT || 3001;
app.use(express.json({ limit: '50mb' }));

// --- CẤU HÌNH ---
const rawKeys = process.env.GEMINI_API_KEYS || "";
const apiKeys = rawKeys.split(',').map(key => key.trim()).filter(key => key.length > 0);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "123456"; 
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || ""; 
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const HASHNODE_API_KEY = process.env.HASHNODE_API_KEY;
const HASHNODE_PUBLICATION_ID = process.env.HASHNODE_PUBLICATION_ID;

// --- TỪ ĐIỂN VIẾT TẮT ---
const TU_DIEN_VIET_TAT = {
    "pmtl": "Pháp Môn Tâm Linh", "btpp": "Bạch Thoại Phật Pháp", "nnn": "Ngôi nhà nhỏ", "psv": "Phụng Sự Viên", "sh": "Sư Huynh",
    "kbt": "Kinh Bài Tập", "cđb": "Chú Đại Bi", "cdb": "Chú Đại Bi", "tk": "Tâm Kinh", "lpdshv": "Lễ Phật Đại Sám Hối Văn",
    "vsc": "Vãng Sanh Chú", "cdbstc": "Công Đức Bảo Sơn Thần Chú", "cđbstc": "Công Đức Bảo Sơn Thần Chú",
    "nyblvdln": "Như Ý Bảo Luân Vương Đà La Ni", "bkcn": "Bổ Khuyết Chân Ngôn", "tpdtcn": "Thất Phật Diệt Tội Chân Ngôn",
    "qalccn": "Quán Âm Linh Cảm Chân Ngôn", "tvltqdqmvtdln": "Thánh Vô Lượng Thọ Quyết Định Quang Minh Vương Đà La Ni",
    "ps": "Phóng Sinh", "xf": "Xoay pháp", "knt": "Khai Nghiệp Tướng", "ht": "Huyền Trang"
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

async function sendTelegramAlert(message) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
        await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: `🤖 <b>PSV ẢO "Văn Tư Tu"</b>\n\n${message}`, parse_mode: 'HTML' });
    } catch (error) { console.error("Telegram Error:", error.message); }
}

// --- HÀM TÌM KIẾM HASHNODE (GraphQL) ---
async function searchHashnode(query) {
    const graphqlQuery = {
        query: `
            query SearchPosts($publicationId: ObjectId!, $query: String!) {
              publication(id: $publicationId) {
                searchPosts(query: $query, first: 5) {
                  edges {
                    node {
                      title
                      url
                      content { text }
                    }
                  }
                }
              }
            }
        `,
        variables: {
            publicationId: HASHNODE_PUBLICATION_ID,
            query: query
        }
    };

    try {
        const response = await axios.post('https://gql.hashnode.com/', graphqlQuery, {
            headers: {
                'Authorization': HASHNODE_API_KEY,
                'Content-Type': 'application/json'
            }
        });
        const edges = response.data?.data?.publication?.searchPosts?.edges || [];
        return edges.map(edge => ({
            title: edge.node.title,
            url: edge.node.url,
            content: edge.node.content.text
        }));
    } catch (error) {
        console.error("Lỗi Hashnode API:", error.message);
        return [];
    }
}

// --- GỌI GEMINI ---
async function callGeminiWithRetry(payload, keyIndex = 0, retryCount = 0, modelName = "gemini-2.5-flash-lite") {
    if (keyIndex >= apiKeys.length) {
        if (retryCount < 1) { 
            await sleep(2000);
            return callGeminiWithRetry(payload, 0, retryCount + 1, modelName);
        }
        throw new Error("ALL_KEYS_EXHAUSTED");
    }
    const currentKey = apiKeys[keyIndex];
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${currentKey}`;
    try {
        return await axios.post(apiUrl, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 60000 });
    } catch (error) {
        if (error.response && [429, 400, 403, 500, 503].includes(error.response.status)) {
            const delay = Math.floor(Math.random() * 2000) + 1000;
            await sleep(delay); 
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

        // 1. Nhắn tin trực tiếp Admin (@psv)
        if (question.trim().toLowerCase().startsWith("@psv")) {
            const parts = question.split(':');
            if (parts.length < 2) return res.json({ answer: "Sư huynh vui lòng nhập nội dung sau dấu hai chấm." });
            const msgContent = parts.slice(1).join(':').trim();
            const safeMsg = escapeHtml(msgContent);
            const teleRes = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                chat_id: TELEGRAM_CHAT_ID,
                text: `📨 <b>TIN NHẮN TRỰC TIẾP</b>\n\n"${safeMsg}"\n\n👉 <i>Admin Reply để trả lời.</i>`,
                parse_mode: 'HTML'
            });
            if (teleRes.data && socketId) {
                const msgId = teleRes.data.result.message_id;
                pendingRequests.set(msgId, socketId);
            }
            return res.json({ answer: "✅ Đệ đã chuyển tin nhắn riêng tới Ban quản trị ạ! 🙏" });
        }

        // 2. Tìm kiếm trên Hashnode
        const fullQuestion = dichVietTat(question);
        const documents = await searchHashnode(fullQuestion);

        const HEADER_MSG = "Đệ chào Sư huynh! Đệ đã tìm thấy thông tin liên quan trên blog Hashnode của Sư huynh ạ:\n\n";
        const FOOTER_MSG = "\n\nSư huynh cần tìm hiểu thêm gì cứ bảo đệ nhé!";

        if (!documents || documents.length === 0) {
            await sendTelegramAlert(`❓ <b>KHÔNG TÌM THẤY TRÊN HASHNODE</b>\n\nUser: "${escapeHtml(question)}"`);
            return res.json({ answer: "Đệ tìm trên blog Hashnode không thấy thông tin này. Đệ đã báo Ban quản trị hỗ trợ Sư huynh rồi ạ!" });
        }

        // 3. Gemini xử lý và định dạng kết quả
        let contextString = "";
        documents.forEach((doc, index) => {
            contextString += `Bài #${index + 1}: ${doc.title}\nLink: ${doc.url}\nNội dung: ${doc.content.substring(0, 1500)}\n\n`;
        });

        const systemPrompt = `
            NHIỆM VỤ: Trích xuất thông tin trả lời cho câu hỏi: "${fullQuestion}".
            DỮ LIỆU TỪ HASHNODE:
            ${contextString}

            YÊU CẦU:
            1. Trình bày ý chính theo gạch đầu dòng.
            2. Dưới mỗi ý chính BẮT BUỘC ghi rõ tiêu đề bài và dán link bài gốc.
            3. Dùng giọng văn khiêm cung (Đệ - Sư huynh).
            4. Trả về định dạng text sạch sẽ.
        `;

        const response = await callGeminiWithRetry(
            { contents: [{ parts: [{ text: systemPrompt }] }] }, 
            getRandomStartIndex()
        );
        
        let aiResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "Đệ xin lỗi, AI đang bận tí ạ.";
        res.json({ answer: HEADER_MSG + aiResponse + FOOTER_MSG });

    } catch (error) {
        console.error("Lỗi Chat Server:", error.message);
        res.status(500).json({ error: "Lỗi hệ thống: " + error.message });
    }
});

// --- API WEBHOOK: ADMIN REPLY TỪ TELEGRAM ---
app.post(`/api/telegram-webhook/${process.env.TELEGRAM_TOKEN}`, async (req, res) => {
    try {
        const { message } = req.body;
        if (message && message.reply_to_message) {
            const originalMsgId = message.reply_to_message.message_id; 
            if (pendingRequests.has(originalMsgId)) {
                const userSocketId = pendingRequests.get(originalMsgId);
                if (message.photo) {
                    const fileId = message.photo[message.photo.length - 1].file_id;
                    const getFileUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/getFile?file_id=${fileId}`;
                    const fileInfoRes = await axios.get(getFileUrl);
                    const downloadUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${fileInfoRes.data.result.file_path}`;
                    const imageRes = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
                    const base64Image = Buffer.from(imageRes.data, 'binary').toString('base64');
                    io.to(userSocketId).emit('admin_reply_image', `data:image/jpeg;base64,${base64Image}`);
                    if (message.caption) io.to(userSocketId).emit('admin_reply', message.caption);
                } else if (message.text) {
                    io.to(userSocketId).emit('admin_reply', message.text);
                }
            }
        }
        res.sendStatus(200); 
    } catch (e) { res.sendStatus(500); }
});

app.get('/api/health', (req, res) => res.send("Server Hashnode-Chatbot is Online!"));

server.listen(PORT, () => console.log(`Server đang chạy tại cổng ${PORT}`));
