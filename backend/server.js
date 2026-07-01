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

// Bộ nhớ tạm Map có thể xóa bỏ nếu Sư huynh dùng cách "giấu ID vào tin nhắn"
// Nhưng đệ vẫn giữ lại phần connection để Sư huynh theo dõi logs
io.on('connection', (socket) => {
    console.log('👤 User Connected:', socket.id);
});

const PORT = process.env.PORT || 3001;
app.use(express.json({ limit: '50mb' }));

// --- CẤU HÌNH ---
const rawKeys = process.env.GEMINI_API_KEYS || "";
const apiKeys = rawKeys.split(',').map(key => key.trim()).filter(key => key.length > 0);
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || ""; 
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
// --- CẤU HÌNH GHOST CMS ---
const GHOST_API_URL = process.env.GHOST_API_URL || "";
const GHOST_CONTENT_API_KEY = process.env.GHOST_CONTENT_API_KEY || "";

// --- TỪ ĐIỂN VIẾT TẮT ---
const TU_DIEN_VIET_TAT = {
    "pmtl": "Pháp Môn Tâm Linh", 
    "btpp": "Bạch Thoại Phật Pháp", 
    "nnn": "Ngôi nhà nhỏ",
    "kvtt": "Kinh Văn Tự Tu", // Đã thêm từ khóa mới của bạn
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

// --- HÀM TÌM KIẾM GHOST CMS (CẢI TIẾN THÔNG MINH BẰNG TỪ KHÓA) ---
async function searchGhost(query) {
    const cleanApiUrl = String(GHOST_API_URL).trim().replace(/\/$/, "");
    const cleanApiKey = String(GHOST_CONTENT_API_KEY).trim();
    const cleanQuery = String(query || "").trim().toLowerCase();

    try {
        // Lấy tất cả bài viết (hoặc limit=50 nếu blog quá lớn) để lọc
        const apiUrl = `${cleanApiUrl}/ghost/api/content/posts/?key=${cleanApiKey}&limit=all&formats=plaintext&fields=id,title,url,plaintext`;
        
        const response = await axios.get(apiUrl, { timeout: 30000 });
        const posts = response.data?.posts || [];

        // 1. Tách câu hỏi của user thành từng từ khóa riêng lẻ
        // Ví dụ: "bị tê khi niệm kinh" -> ["bị", "tê", "khi", "niệm", "kinh"]
        const keywords = cleanQuery.split(/\s+/).filter(word => word.length > 0);

        // 2. Chấm điểm mức độ liên quan cho từng bài viết
        const scoredPosts = posts.map(post => {
            const title = (post.title || "").toLowerCase();
            const content = (post.plaintext || "").toLowerCase();
            let score = 0;

            // Thưởng điểm RẤT CAO nếu khớp nguyên văn cả cụm (phòng trường hợp gõ chuẩn)
            if (title.includes(cleanQuery)) score += 50;
            if (content.includes(cleanQuery)) score += 20;

            // Thưởng điểm cho MỖI từ khóa xuất hiện trong bài
            keywords.forEach(kw => {
                if (title.includes(kw)) score += 5; // Từ khóa có trong tiêu đề: +5 điểm
                if (content.includes(kw)) score += 1; // Từ khóa có trong nội dung: +1 điểm
            });

            return { ...post, score };
        });

        // 3. Lọc bỏ các bài điểm quá thấp (< 3) và Sắp xếp điểm từ cao xuống thấp
        const matchedPosts = scoredPosts
            .filter(post => post.score > 3)
            .sort((a, b) => b.score - a.score);

        // 4. Chỉ trả về 5 bài có điểm cao nhất cho Gemini đọc
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

// --- HÀM TÌM KIẾM CHUYÊN ĐỀ (TAGS) TỪ GHOST CMS ---
async function searchGhostTags(query) {
    const cleanApiUrl = String(GHOST_API_URL).trim().replace(/\/$/, "");
    const cleanApiKey = String(GHOST_CONTENT_API_KEY).trim();
    const cleanQuery = String(query || "").trim().toLowerCase();

    try {
        // Gọi API lấy toàn bộ tags của Ghost CMS
        const apiUrl = `${cleanApiUrl}/ghost/api/content/tags/?key=${cleanApiKey}&limit=all`;
        const response = await axios.get(apiUrl, { timeout: 15000 });
        const tags = response.data?.tags || [];

        // Lọc các tag mà tên của nó xuất hiện trong câu hỏi của người dùng
        // Ví dụ: Câu hỏi "niệm kinh văn tự tu thế nào", Tag name: "Kinh Văn Tự Tu" => Khớp!
        const matchedTags = tags.filter(tag => {
            const tagName = (tag.name || "").toLowerCase();
            return tagName.length > 2 && cleanQuery.includes(tagName);
        });

        return matchedTags.map(tag => ({
            name: tag.name,
            url: tag.url // Ghost CMS tự động trả về URL chuẩn của tag
        }));
    } catch (error) {
        console.error("Lỗi Ghost Tags API:", error.message);
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

        // 1. TÍNH NĂNG: Nhắn tin trực tiếp Admin (@psv)
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

        // 2. TÌM KIẾM DỮ LIỆU TRÊN GHOST CMS (Cả bài lẻ & Tags)
        const fullQuestion = dichVietTat(question);
        
        // Chạy song song 2 hàm tìm kiếm để tiết kiệm thời gian phản hồi
        const [documents, matchedTags] = await Promise.all([
            searchGhost(fullQuestion),
            searchGhostTags(fullQuestion)
        ]);

        const HEADER_MSG = "Đệ chào Sư huynh, dưới đây là thông tin đệ tìm được ạ:\n\n";
        const FOOTER_MSG = "\n\nSư huynh cần đệ giúp gì xin cứ đặt câu hỏi nhé!";

        // Tạo thông báo về Chuyên đề (Tag) nếu có
        let TAG_MSG = "";
        if (matchedTags && matchedTags.length > 0) {
            // Lấy tag đầu tiên tìm được để giới thiệu
            TAG_MSG = `📚 **Chuyên đề liên quan:** Đệ thấy Sư huynh đang quan tâm đến chủ đề **${matchedTags[0].name}**. Sư huynh có thể xem tổng hợp toàn bộ bài viết của chuyên đề này tại đây nhé:\n👉 Link: ${matchedTags[0].url}\n\n---\n\n`;
        }

        // --- XỬ LÝ KHI KHÔNG TÌM THẤY CẢ BÀI VIẾT LẪN CHUYÊN ĐỀ ---
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

        // Nếu chỉ tìm thấy TAG mà không có bài viết lẻ cụ thể khớp điểm cao
        if (!documents || documents.length === 0) {
            return res.json({ answer: HEADER_MSG + TAG_MSG + FOOTER_MSG });
        }

        // 3. NẾU CÓ DỮ LIỆU BÀI LẺ: Gọi Gemini trích dẫn nguyên văn
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

        const response = await callGeminiWithRetry(
            { contents: [{ parts: [{ text: systemPrompt }] }] }, 
            getRandomStartIndex()
        );
        
        let aiBody = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "NO_DATA";

        if (aiBody.includes("NO_DATA")) {
            // 1. Vẫn gửi tin nhắn báo cho Admin biết để hỗ trợ nếu cần
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                chat_id: TELEGRAM_CHAT_ID,
                text: `❓ <b>AI KHÔNG THỂ TRÍCH DẪN NGUYÊN VĂN</b>\nUser: "${escapeHtml(question)}"\n\n<code>#id_${socketId}</code>`,
                parse_mode: 'HTML'
            });

            // 2. Trả về danh sách bài viết liên quan để user tự tham khảo
            let suggestMsg = "Đệ chưa tìm được đoạn trích dẫn nguyên văn sát với câu hỏi. Tuy nhiên đệ thấy có các bài viết liên quan sau đây, Sư huynh bấm vào link để đọc tham khảo nhé ạ:\n\n";
            documents.forEach((doc, index) => {
                suggestMsg += `* [${doc.title}]\nLink: ${doc.url}\n\n`;
            });

            return res.json({ answer: HEADER_MSG + suggestMsg + FOOTER_MSG });
        }

        res.json({ answer: HEADER_MSG + aiBody + FOOTER_MSG });

    } catch (error) {
        console.error("Lỗi:", error.message);
        res.status(500).json({ error: "Lỗi hệ thống." });
    }
});

// --- API WEBHOOK: ADMIN REPLY TỪ TELEGRAM ---
app.post(`/api/telegram-webhook/${process.env.TELEGRAM_TOKEN}`, async (req, res) => {
    try {
        const { message } = req.body;
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
                    const base64Image = Buffer.from(imageRes.data, 'binary').toString('base64');
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

app.get('/api/health', (req, res) => res.send("Server Online!"));
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
