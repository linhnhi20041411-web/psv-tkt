const express = require('express');
const axios = require('axios');
const cors = require('cors');
const http = require('http'); 
const { Server } = require("socket.io");
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Parser = require('rss-parser'); 
require('dotenv').config();

const parser = new Parser();
const app = express();
// ---> THÊM ĐOẠN KHỞI TẠO SOCKET NÀY:
const server = http.createServer(app); // Tạo server bọc lấy app
const io = new Server(server, {
    cors: { origin: "*" } // Cho phép mọi nguồn kết nối
});

// Biến lưu trữ tạm: Tin nhắn Telegram ID -> Socket ID người dùng
const pendingRequests = new Map();
const socketToMsgId = new Map();

// Lắng nghe kết nối
io.on('connection', (socket) => {
    console.log('👤 User Connected:', socket.id);

    socket.on('disconnect', () => {
        // Dọn dẹp bộ nhớ khi user thoát
        if (socketToMsgId.has(socket.id)) {
            const msgIds = socketToMsgId.get(socket.id);
            // Xóa các request đang chờ của user này
            if (msgIds) {
                msgIds.forEach(id => pendingRequests.delete(id));
            }
            socketToMsgId.delete(socket.id);
        }
    });
});

const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: '50mb' }));
app.use(cors());

// --- 1. CẤU HÌNH ---
const rawKeys = process.env.GEMINI_API_KEYS || "";
const apiKeys = rawKeys.split(',').map(key => key.trim()).filter(key => key.length > 0);
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "123456"; 

// CẤU HÌNH TELEGRAM
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || ""; 
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

if (!supabaseUrl || !supabaseKey) console.error("❌ LỖI: Thiếu SUPABASE_URL hoặc SUPABASE_KEY");
const supabase = createClient(supabaseUrl, supabaseKey);

// --- 2. BỘ TỪ ĐIỂN VIẾT TẮT ---
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

// --- 3. CÁC HÀM TIỆN ÍCH ---
function getRandomStartIndex() { return Math.floor(Math.random() * apiKeys.length); }
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function sendTelegramAlert(message) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
        await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: `🤖 <b>PSV ẢO VĂN TƯ TU</b> 🚨\n\n${message}`, parse_mode: 'HTML' });
    } catch (error) { console.error("Telegram Error:", error.message); }
}

function cleanText(text) {
    if (!text) return "";
    // Xóa thẻ HTML, thay br/p bằng xuống dòng
    let clean = text.replace(/<br\s*\/?>/gi, '\n')
                    .replace(/<\/p>/gi, '\n')
                    .replace(/<[^>]*>?/gm, '')
                    .replace(/&nbsp;/g, ' ')
                    .replace(/\r\n/g, '\n');   
    // Xóa dòng trống thừa
    return clean.replace(/\n\s*\n\s*\n/g, '\n\n').trim();
}

function chunkText(text, maxChunkSize = 2000) {
    if (!text) return [];
    // Tách theo đoạn văn
    const paragraphs = text.split(/\n\s*\n/);
    const chunks = [];
    let currentChunk = "";
    
    for (const p of paragraphs) {
        const cleanP = p.trim();
        if (!cleanP) continue;
        
        // Nếu cộng thêm đoạn này mà vẫn nhỏ hơn maxChunkSize thì gộp vào
        if ((currentChunk.length + cleanP.length) < maxChunkSize) { 
            currentChunk += (currentChunk ? "\n\n" : "") + cleanP; 
        } else { 
            // Nếu lớn hơn thì đẩy chunk cũ đi, tạo chunk mới
            if (currentChunk.length > 50) chunks.push(currentChunk); 
            currentChunk = cleanP; 
        }
    }
    // Đẩy nốt chunk cuối cùng
    if (currentChunk.length > 50) chunks.push(currentChunk);
    return chunks;
}

// --- 4. GỌI GEMINI (CÓ RETRY & TELEGRAM) ---
async function callGeminiWithRetry(payload, keyIndex = 0, retryCount = 0) {
    if (keyIndex >= apiKeys.length) {
        if (retryCount < 1) {
            console.log("🔁 Hết vòng Key, chờ 2s thử lại...");
            await sleep(2000);
            return callGeminiWithRetry(payload, 0, retryCount + 1);
        }
        const msg = "🆘 HẾT SẠCH API KEY! Hệ thống không thể phản hồi.";
        console.error(msg);
        await sendTelegramAlert(msg);
        throw new Error("ALL_KEYS_EXHAUSTED");
    }

    const currentKey = apiKeys[keyIndex];
    const model = "gemini-2.5-flash"; 
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${currentKey}`;

    try {
        return await axios.post(apiUrl, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 60000 });
    } catch (error) {
        const status = error.response ? error.response.status : 0;
        if (status === 429 || status === 400 || status === 403 || status >= 500) {
            console.warn(`⚠️ Key ${keyIndex} lỗi (Mã: ${status}). Đổi Key...`);
            if (status === 429) await sleep(1000); 
            return callGeminiWithRetry(payload, keyIndex + 1, retryCount);
        }
        throw error;
    }
}

// --- HÀM 5: PHÂN TÍCH & CHUẨN HÓA CÂU HỎI (QUAN TRỌNG) ---
async function aiExtractKeywords(userQuestion) {
    // Prompt này ép AI phải "hiểu" tình huống chứ không được "bịa" từ khóa
    const prompt = `
    Đóng vai: Bạn là Thư ký quản lý thư viện Khai Thị (Pháp Môn Tâm Linh).
    
    NHIỆM VỤ:
    Đọc câu hỏi "tình huống" của người dùng và chuyển đổi nó thành một "Câu hỏi tra cứu" ngắn gọn, dùng đúng thuật ngữ chuyên môn để tìm trong Mục Lục.

    INPUT CỦA NGƯỜI DÙNG: "${userQuestion}"

    QUY TRÌNH TƯ DUY (BẮT BUỘC):
    1. Xác định Hành Động/Sự Cố (Ví dụ: Chấm thiếu, viết sai họ tên, làm rách, đốt nhầm...).
    2. Xác định Đối Tượng (Ví dụ: Ngôi nhà nhỏ, bài Chú Đại Bi, Lư hương...).
    3. Ghép lại thành câu hỏi dạng: "Quy định về..." hoặc "Cách xử lý khi...".

    VÍ DỤ MẪU (Học theo cách tư duy này):
    - User: "đệ quên chấm đủ số biến kinh đã niệm lên nnn, sau đó đệ lại đốt đi rồi, bây giờ đệ phải làm thế nào ?"
    -> Output: Cách xử lý khi lỡ hóa Ngôi nhà nhỏ chưa chấm đủ kinh
    
    - User: "mình lỡ làm rớt tờ nnn xuống đất bị bẩn thì có dùng được không"
    -> Output: Quy định về Ngôi nhà nhỏ bị bẩn hoặc rơi xuống đất
    
    - User: "hôm nay lỡ ăn mặn rồi có được tụng kinh không"
    -> Output: Quy định về việc tụng kinh sau khi ăn đồ mặn

    YÊU CẦU ĐẦU RA:
    Chỉ trả về duy nhất câu hỏi đã chuẩn hóa. Không giải thích gì thêm.
    `;
    
    try {
        const response = await callGeminiWithRetry({ contents: [{ parts: [{ text: prompt }] }] }, getRandomStartIndex());
        let refinedQuery = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || userQuestion;
        
        // Làm sạch kết quả
        refinedQuery = refinedQuery.replace(/\n/g, " ").replace(/["']/g, "").replace(/^Output:\s*/i, "");
        
        console.log(`🧠 User hỏi: "${userQuestion}"`);
        console.log(`💡 AI hiểu là: "${refinedQuery}"`); // Xem log để kiểm tra độ thông minh
        
        return refinedQuery;
    } catch (e) { 
        console.error("Lỗi phân tích câu hỏi:", e.message);
        return userQuestion; // Nếu lỗi thì dùng tạm câu gốc
    }
}

async function callEmbeddingWithRetry(text, keyIndex = 0, retryCount = 0) {
    if (retryCount >= apiKeys.length) { await sendTelegramAlert("Hết key embedding"); throw new Error("Hết Key Embedding."); }
    const currentIndex = keyIndex % apiKeys.length;
    try {
        const genAI = new GoogleGenerativeAI(apiKeys[currentIndex]);
        const model = genAI.getGenerativeModel({ model: "text-embedding-004"});
        const result = await model.embedContent(text);
        return result.embedding.values;
    } catch (error) {
        if (error.status === 429) { await sleep(500); return callEmbeddingWithRetry(text, currentIndex + 1, retryCount + 1); }
        throw error;
    }
}

// --- 5. HÀM TÌM KIẾM THÔNG MINH (TITLE PRIORITY + VECTOR) ---
async function searchSupabaseContext(query) {
    try {
        console.log(`🔎 Đang tìm kiếm: "${query}"`);
        
        // --- CHIẾN THUẬT 1: TÌM TRONG TIÊU ĐỀ (TEXT SEARCH) ---
        // Ưu tiên tuyệt đối các bài có tiêu đề khớp với từ khóa
        // Ví dụ: query="mở nhà hàng" -> Khớp ngay bài "Vấn đề mở nhà hàng chay"
        const { data: titleMatches, error: titleError } = await supabase
            .from('vn_buddhism_content')
            .select('*')
            // .textSearch('fts', `'${query}'`, { config: 'english', type: 'websearch' }) // <--- Comment dòng này lại hoặc xóa đi
            .ilike('content', `%Tiêu đề: %${query}%`) // Chỉ giữ lại dòng này là đủ an toàn
            .limit(5);

        // --- CHIẾN THUẬT 2: TÌM THEO VECTOR (SEMANTIC SEARCH) ---
        const startIndex = getRandomStartIndex();
        const queryVector = await callEmbeddingWithRetry(query, startIndex);

        const { data: vectorMatches, error: vectorError } = await supabase.rpc('hybrid_search', {
            query_text: query,
            query_embedding: queryVector,
            match_count: 30, // Lấy 30 bài liên quan
            rrf_k: 60
        });

        if (vectorError) throw vectorError;

        // --- GỘP KẾT QUẢ (MERGE & DEDUPLICATE) ---
        // Nguyên tắc: Bài khớp Tiêu đề (Chiến thuật 1) phải đứng đầu danh sách
        
        const allDocs = [];
        const seenUrls = new Set();

        // 1. Đưa kết quả khớp Tiêu đề vào trước
        if (titleMatches && titleMatches.length > 0) {
            console.log(`✅ Tìm thấy ${titleMatches.length} bài khớp tiêu đề.`);
            titleMatches.forEach(doc => {
                if (!seenUrls.has(doc.url)) {
                    seenUrls.add(doc.url);
                    allDocs.push(doc);
                }
            });
        }

        // 2. Đưa kết quả Vector vào sau
        if (vectorMatches && vectorMatches.length > 0) {
            vectorMatches.forEach(doc => {
                if (!seenUrls.has(doc.url)) {
                    seenUrls.add(doc.url);
                    allDocs.push(doc);
                }
            });
        }

        return allDocs.length > 0 ? allDocs : null;

    } catch (error) {
        console.error("Lỗi tìm kiếm:", error.message);
        return null; 
    }
}

app.post('/api/chat', async (req, res) => {
    try {
        const { question, socketId } = req.body; 
        if (!question) return res.status(400).json({ error: 'Thiếu câu hỏi.' });

        const fullQuestion = dichVietTat(question);
        
        // Bước 1: Tư duy từ khóa (Giữ nguyên)
        const searchKeywords = await aiExtractKeywords(fullQuestion);
        console.log(`🗣️ User: "${question}" -> Key: "${searchKeywords}"`);

        // Bước 2: Tìm kiếm dữ liệu
        const documents = await searchSupabaseContext(searchKeywords);

        // Biến cờ: Xác định xem có cần người hỗ trợ không
        let needHumanSupport = false;
        let aiResponse = "";

        // TRƯỜNG HỢP 1: Không tìm thấy bài nào trong Database
        if (!documents || documents.length === 0) {
            needHumanSupport = true;
        } else {
            // TRƯỜNG HỢP 2: Có bài viết, NHƯNG phải kiểm tra xem nội dung có liên quan không
            let contextString = "";
            documents.forEach((doc, index) => {
                contextString += `--- Nguồn #${index + 1} ---\nLink: ${doc.url}\nTiêu đề: ${doc.metadata?.title || 'No Title'}\nNội dung: ${doc.content.substring(0, 800)}...\n`;
            });

            // --- PROMPT "SIẾT CHẶT" ---
            const systemPrompt = `
            Bạn là Máy Tra Cứu Thông Tin (Pháp Môn Tâm Linh).
            
            DỮ LIỆU THAM KHẢO:
            ${contextString}
            
            CÂU HỎI: "${fullQuestion}"
            
            QUY TẮC BẮT BUỘC (TUÂN THỦ 100%):
            1. Đọc kỹ "DỮ LIỆU THAM KHẢO".
            2. Nếu dữ liệu KHÔNG chứa câu trả lời cho câu hỏi (hoặc câu hỏi không liên quan đến Phật pháp/Tâm linh như hỏi thời tiết, giá vàng, xổ số...):
               -> Chỉ trả về đúng duy nhất cụm từ: "NO_INFO"
            3. Nếu dữ liệu CÓ chứa câu trả lời:
               -> Trả lời ngắn gọn dựa trên dữ liệu.
               -> Cuối câu dán Link gốc.
               -> Không chào hỏi, không thêm lời dẫn thừa.
            `;

            const startIndex = getRandomStartIndex();
            const response = await callGeminiWithRetry({ contents: [{ parts: [{ text: systemPrompt }] }] }, startIndex);

            aiResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "NO_INFO";
            
            // Nếu AI trả về "NO_INFO", nghĩa là nó thấy bài viết không liên quan
            if (aiResponse.includes("NO_INFO")) {
                needHumanSupport = true;
            }
        }

        // =====================================================================
        // XỬ LÝ KẾT QUẢ CUỐI CÙNG
        // =====================================================================
        
        if (needHumanSupport) {
            console.log("⚠️ Câu hỏi không có trong Data hoặc không liên quan -> Chuyển Telegram.");

            // 1. Gửi Telegram
            const teleRes = await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
                chat_id: process.env.TELEGRAM_CHAT_ID,
                text: `❓ <b>CÂU HỎI CẦN HỖ TRỢ</b>\n\n"${question}"\n\n👉 <i>Admin hãy Reply tin nhắn này để trả lời.</i>`,
                parse_mode: 'HTML'
            });

            // 2. Lưu lại mối liên hệ
            if (teleRes.data && teleRes.data.result && socketId) {
                const msgId = teleRes.data.result.message_id;
                
                // Lưu xuôi
                pendingRequests.set(msgId, socketId);

                if (!socketToMsgId.has(socketId)) {
                    socketToMsgId.set(socketId, []);
                }
                socketToMsgId.get(socketId).push(msgId);
            }

            // 3. Trả về câu thông báo mặc định (Đã sửa chính tả giúp bạn: nát -> lát, huỳnh -> huynh)
            return res.json({ 
                answer: "Đệ đang chuyển câu hỏi của Sư huynh cho các PSV khác hỗ trợ, mong Sư huynh chờ trong giây lát nhé ! 🙏" 
            });
        }

        // Nếu có câu trả lời từ AI
        aiResponse = aiResponse.replace(/[\[\]]/g, ""); // Làm sạch dấu ngoặc
        res.json({ answer: "**Phụng Sự Viên Ảo Trả Lời:**\n\n" + aiResponse });

    } catch (error) {
        console.error("Lỗi Chat Server:", error.message);
        await sendTelegramAlert(`❌ LỖI API CHAT:\nUser: ${req.body.question}\nError: ${error.message}`);
        res.status(500).json({ error: "Lỗi hệ thống: " + error.message });
    }
});

// --- API NHẬN TIN NHẮN TỪ TELEGRAM (WEBHOOK - HỖ TRỢ ẢNH) ---
app.post(`/api/telegram-webhook/${process.env.TELEGRAM_TOKEN}`, async (req, res) => {
    try {
        const { message } = req.body;
        
        // Kiểm tra xem có phải là tin nhắn TRẢ LỜI (Reply) không
        if (message && message.reply_to_message) {
            const originalMsgId = message.reply_to_message.message_id; // ID câu hỏi gốc
            
            // Kiểm tra xem câu hỏi gốc có trong danh sách chờ không
            if (pendingRequests.has(originalMsgId)) {
                const userSocketId = pendingRequests.get(originalMsgId);
                
                // --- TRƯỜNG HỢP 1: ADMIN GỬI ẢNH ---
                if (message.photo) {
                    try {
                        // 1. Lấy file_id của ảnh chất lượng cao nhất (cái cuối cùng trong mảng)
                        const fileId = message.photo[message.photo.length - 1].file_id;
                        
                        // 2. Lấy đường dẫn file từ Telegram
                        const getFileUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/getFile?file_id=${fileId}`;
                        const fileInfoRes = await axios.get(getFileUrl);
                        const filePath = fileInfoRes.data.result.file_path;

                        // 3. Tải ảnh về và chuyển sang Base64
                        const downloadUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${filePath}`;
                        const imageRes = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
                        const base64Image = Buffer.from(imageRes.data, 'binary').toString('base64');
                        const imgSrc = `data:image/jpeg;base64,${base64Image}`;

                        // 4. Gửi ảnh qua Socket
                        io.to(userSocketId).emit('admin_reply_image', imgSrc);
                        console.log(`📸 Đã chuyển ẢNH tới Socket: ${userSocketId}`);

                        // Nếu có caption (chú thích ảnh) thì gửi thêm text
                        if (message.caption) {
                            io.to(userSocketId).emit('admin_reply', message.caption);
                        }

                    } catch (imgError) {
                        console.error("Lỗi xử lý ảnh:", imgError.message);
                        io.to(userSocketId).emit('admin_reply', "[Lỗi: Admin gửi ảnh nhưng hệ thống không tải được]");
                    }
                } 
                // --- TRƯỜNG HỢP 2: ADMIN GỬI TEXT ---
                else if (message.text) {
                    const adminReply = message.text; 
                    io.to(userSocketId).emit('admin_reply', adminReply);
                    console.log(`✅ Đã chuyển TEXT tới Socket: ${userSocketId}`);
                }
                
                // Lưu ý: Không xóa pendingRequests để admin có thể chat tiếp
            }
        }
        res.sendStatus(200); 
    } catch (e) {
        console.error("Lỗi Webhook:", e);
        res.sendStatus(500);
    }
});

// --- CÁC API ADMIN (CÓ BÁO LỖI TELEGRAM) ---

// API SYNC
app.post('/api/admin/sync-blogger', async (req, res) => {
    const { password, blogUrl } = req.body;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('Transfer-Encoding', 'chunked');
    if (password !== ADMIN_PASSWORD) { res.write("❌ Sai mật khẩu!\n"); return res.end(); }
    
    try {
        const cleanBlogUrl = blogUrl.replace(/\/$/, "");
        const rssUrl = `${cleanBlogUrl}/feeds/posts/default?alt=rss&max-results=100`;
        res.write(`📡 Kết nối RSS: ${rssUrl}\n`);
        
        const feed = await parser.parseURL(rssUrl);
        res.write(`✅ Tìm thấy ${feed.items.length} bài.\n`);
        
        let errCount = 0;
        for (const post of feed.items) {
            // ... (Logic cũ)
            const { count } = await supabase.from('vn_buddhism_content').select('*', { count: 'exact', head: true }).eq('url', post.link);
            if (count > 0) continue;
            const cleanContent = cleanText(post.content || post['content:encoded'] || "");
            if (cleanContent.length < 50) continue;
            const chunks = chunkText(cleanContent);
            res.write(`⚙️ Nạp: ${post.title.substring(0,30)}...\n`);
            for (const chunk of chunks) {
                try {
                    const embedding = await callEmbeddingWithRetry(`Tiêu đề: ${post.title}\nNội dung: ${chunk}`, getRandomStartIndex());
                    await supabase.from('vn_buddhism_content').insert({
                        content: `Tiêu đề: ${post.title}\nNội dung: ${chunk}`, embedding, url: post.link, original_id: 0, metadata: { title: post.title, type: 'rss_auto' }
                    });
                } catch (e) { 
                    res.write(`❌ Lỗi: ${e.message}\n`); 
                    errCount++;
                }
            }
            await sleep(300);
        }
        if (errCount > 5) await sendTelegramAlert(`⚠️ Cảnh báo Sync Blogger: Có ${errCount} lỗi xảy ra trong quá trình nạp.`);
        res.write(`\n🎉 HOÀN TẤT!\n`); res.end();
    } catch (e) { 
        res.write(`❌ Lỗi: ${e.message}\n`); 
        await sendTelegramAlert(`❌ LỖI SYNC BLOGGER:\n${e.message}`);
        res.end(); 
    }
});

// API MANUAL ADD
app.post('/api/admin/manual-add', async (req, res) => {
    const { password, url, title, content } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu!" });
    try {
        await supabase.from('vn_buddhism_content').delete().eq('url', url);
        const chunks = chunkText(cleanText(content));
        for (const chunk of chunks) {
            const embedding = await callEmbeddingWithRetry(`Tiêu đề: ${title}\nNội dung: ${chunk}`, getRandomStartIndex());
            await supabase.from('vn_buddhism_content').insert({
                content: `Tiêu đề: ${title}\nNội dung: ${chunk}`, embedding, url, original_id: 0, metadata: { title, type: 'manual' }
            });
            await sleep(300);
        }
        res.json({ message: "Thành công!", logs: ["Đã lưu xong."] });
    } catch (e) { 
        await sendTelegramAlert(`❌ Lỗi Manual Add (${title}):\n${e.message}`);
        res.status(500).json({ error: e.message }); 
    }
});

// API CHECK BATCH (Có phát hiện Soft 404)
app.post('/api/admin/check-batch', async (req, res) => {
    const { password, urls } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu!" });
    
    const results = { checked: 0, deleted: 0, errors: 0, logs: [] };
    const BLOGGER_ERROR_TEXT = "Rất tiếc, trang bạn đang tìm trong blog này không tồn tại";
    
    try {
        for (const url of urls) {
            try {
                const response = await axios.get(url, { timeout: 8000, validateStatus: s => s < 500 });
                let isDead = response.status === 404;
                if (response.status === 200 && typeof response.data === 'string' && response.data.includes(BLOGGER_ERROR_TEXT)) isDead = true;

                if (isDead) {
                    const { error } = await supabase.from('vn_buddhism_content').delete().eq('url', url);
                    if (!error) { results.deleted++; results.logs.push(`🗑️ Đã xóa: ${url}`); } else results.errors++;
                } else results.checked++;
            } catch (err) { results.errors++; }
            await sleep(100);
        }
        res.json(results);
    } catch (e) { 
        await sendTelegramAlert(`❌ Lỗi Check Batch:\n${e.message}`);
        res.status(500).json({ error: e.message }); 
    }
});

// API Get All Urls & Check Latest (Giữ nguyên, không cần báo lỗi Telegram cho các API đọc dữ liệu đơn giản này)
app.post('/api/admin/get-all-urls', async (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu!" });
    try {
        let allUrls = [], from = 0, step = 999, keepGoing = true;
        while (keepGoing) {
            const { data, error } = await supabase.from('vn_buddhism_content').select('url').range(from, from + step);
            if (error) throw error;
            if (data.length > 0) { allUrls = allUrls.concat(data.map(i => i.url)); from += step + 1; } else { keepGoing = false; }
        }
        res.json({ success: true, urls: [...new Set(allUrls)] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/check-latest', async (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu!" });
    try {
        const { data } = await supabase.from('vn_buddhism_content').select('id, url, metadata, created_at').order('id', { ascending: false }).limit(20);
        const unique = []; const seen = new Set();
        data.forEach(i => { if (!seen.has(i.url)) { seen.add(i.url); unique.push(i); } });
        res.json({ success: true, data: unique });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- API KIỂM TRA MẬT KHẨU (LOGIN) ---
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.json({ success: true });
    } else {
        res.status(403).json({ error: "Sai mật khẩu!" });
    }
});

// --- API TÌM KIẾM BÀI VIẾT (ĐỂ SỬA) ---
app.post('/api/admin/search-posts', async (req, res) => {
    const { password, keyword } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu!" });

    try {
        // Tìm theo URL hoặc Tiêu đề (trong metadata)
        const { data, error } = await supabase
            .from('vn_buddhism_content')
            .select('id, url, content, metadata, created_at')
            .or(`url.ilike.%${keyword}%, content.ilike.%${keyword}%`)
            .limit(20); // Chỉ lấy 20 kết quả đầu để đỡ lag

        if (error) throw error;
        res.json({ success: true, data });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- API CẬP NHẬT BÀI VIẾT (SỬA & RE-EMBEDDING) ---
app.post('/api/admin/update-post', async (req, res) => {
    const { password, id, content, title } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu!" });

    try {
        // 1. Tính toán lại Vector cho nội dung mới (QUAN TRỌNG)
        // Nếu sửa nội dung mà không sửa vector, AI sẽ tìm kiếm dựa trên nội dung cũ -> Sai lệch.
        const fullText = `Tiêu đề: ${title}\nNội dung: ${content}`;
        const embedding = await callEmbeddingWithRetry(fullText, getRandomStartIndex());

        // 2. Cập nhật vào Supabase
        const { error } = await supabase
            .from('vn_buddhism_content')
            .update({ 
                content: fullText,
                embedding: embedding,
                metadata: { title: title, type: 'edited' } // Đánh dấu là đã sửa
            })
            .eq('id', id);

        if (error) throw error;
        res.json({ success: true, message: "Đã cập nhật nội dung và vector thành công!" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- API XÓA BÀI VIẾT (Đã Fix lỗi undefined) ---
app.post('/api/admin/delete-post', async (req, res) => {
    const { password, id, title } = req.body; 
    
    // 1. In ra log để xem Frontend gửi cái gì lên (Debug)
    console.log("👉 Đang xóa bài với ID:", id); 

    // 2. Kiểm tra dữ liệu đầu vào
    if (!id || id === 'undefined') {
        return res.status(400).json({ error: "Lỗi: Không tìm thấy ID bài viết cần xóa!" });
    }

    if (password !== ADMIN_PASSWORD) {
        return res.status(403).json({ error: "Sai mật khẩu!" });
    }

    try {
        const { error } = await supabase
            .from('vn_buddhism_content')
            .delete()
            .eq('id', id); // ID phải là số

        if (error) throw error;

        await sendTelegramAlert(`🗑️ <b>ADMIN ĐÃ XÓA BÀI VIẾT</b>\n\n🆔 ID: ${id}\n📝 Tiêu đề: ${title || "Không rõ"}`);

        res.json({ success: true, message: "Đã xóa bài viết thành công!" });

    } catch (e) {
        console.error("Lỗi xóa bài:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// --- API XÓA BÀI TRÙNG LẶP (DEDUPLICATE - PHIÊN BẢN QUÉT FULL DATA) ---
app.post('/api/admin/remove-duplicates', async (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Sai mật khẩu!" });

    // Stream log về client
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    try {
        res.write("🔍 Đang tải toàn bộ dữ liệu (Chế độ Phân trang)...\n");

        let allData = [];
        let from = 0;
        const pageSize = 1000; // Mỗi lần tải 1000 bài
        let keepFetching = true;

        // --- VÒNG LẶP TẢI DỮ LIỆU ---
        while (keepFetching) {
            const { data, error } = await supabase
                .from('vn_buddhism_content')
                .select('id, url, content')
                .range(from, from + pageSize - 1); // Lấy từ dòng 'from' đến 'to'

            if (error) throw error;

            if (data.length === 0) {
                keepFetching = false; // Hết dữ liệu thì dừng
            } else {
                allData = allData.concat(data); // Gộp dữ liệu mới vào mảng tổng
                from += pageSize; // Tăng vị trí bắt đầu cho lần sau
                res.write(`... Đã tải được: ${allData.length} bản ghi\n`);
                
                // Nếu số lượng tải về ít hơn pageSize nghĩa là đã đến trang cuối
                if (data.length < pageSize) keepFetching = false;
            }
        }

        res.write(`📂 TỔNG CỘNG: ${allData.length} bản ghi trong Database.\n`);
        res.write("⚙️ Đang phân tích tìm bài trùng...\n");

        const seen = new Set();
        const duplicateIds = [];

        // Duyệt qua từng dòng trong dữ liệu tổng
        for (const item of allData) {
            // Tạo "chữ ký" duy nhất: URL + 100 ký tự đầu của Content
            // Cắt content ngắn gọn để đỡ tốn bộ nhớ
            const contentSig = item.content ? item.content.substring(0, 100) : "empty";
            const signature = `${item.url}|||${contentSig}`;

            if (seen.has(signature)) {
                // Nếu đã thấy chữ ký này rồi -> Đây là bản sao -> Xóa
                duplicateIds.push(item.id);
            } else {
                seen.add(signature);
            }
        }

        if (duplicateIds.length === 0) {
            res.write("✅ Tuyệt vời! Không phát hiện dữ liệu trùng lặp.\n");
            return res.end();
        }

        res.write(`⚠️ Phát hiện ${duplicateIds.length} bản ghi trùng lặp.\n`);
        res.write("🗑️ Đang tiến hành xóa...\n");

        // Chia nhỏ mảng ID để xóa (Supabase giới hạn số lượng trong 1 lệnh xóa)
        const batchSize = 100;
        for (let i = 0; i < duplicateIds.length; i += batchSize) {
            const batch = duplicateIds.slice(i, i + batchSize);
            const { error: delError } = await supabase
                .from('vn_buddhism_content')
                .delete()
                .in('id', batch);
            
            if (delError) {
                res.write(`❌ Lỗi xóa batch ${i}: ${delError.message}\n`);
            } else {
                res.write(`✅ Đã xóa lô ${i + 1} - ${Math.min(i + batchSize, duplicateIds.length)}\n`);
            }
        }

        res.write(`🎉 HOÀN TẤT! Đã dọn dẹp sạch sẽ Database.\n`);
        res.end();

    } catch (e) {
        console.error("Lỗi:", e);
        res.write(`❌ Lỗi hệ thống: ${e.message}\n`);
        res.end();
    }
});

// --- API TEST TELEGRAM (Dùng để kiểm tra kết nối) ---
app.get('/api/test-telegram', async (req, res) => {
    try {
        await sendTelegramAlert("🚀 <b>Test thành công!</b>\nServer của Sư huynh đã kết nối được với Telegram.\n\nChúc Sư huynh một ngày an lạc! 🙏");
        res.json({ success: true, message: "Đã gửi tin nhắn. Sư huynh kiểm tra điện thoại nhé!" });
    } catch (error) {
        res.status(500).json({ error: "Lỗi gửi Telegram: " + error.message });
    }
});

server.listen(PORT, () => {
    console.log(`Server Socket.io đang chạy tại http://localhost:${PORT}`);
});
