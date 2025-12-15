const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Parser = require('rss-parser'); 
require('dotenv').config();

const parser = new Parser();
const app = express();
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

// --- 5. AI EXTRACT & EMBEDDING ---
async function aiExtractKeywords(userQuestion) {
    // Prompt này yêu cầu AI đoán các từ khóa liên quan về mặt ý nghĩa (Semantic Keywords)
    const prompt = `
    Nhiệm vụ: Phân tích câu hỏi người dùng và đưa ra 3-5 cụm từ khóa tìm kiếm liên quan nhất đến giáo lý/tâm linh.
    
    Quy tắc:
    1. Giữ lại từ khóa gốc.
    2. Thêm các từ đồng nghĩa hoặc khái niệm Phật pháp liên quan (Ví dụ: "bệnh ung thư" -> thêm "nghiệp sát sinh", "nghiệp nặng").
    3. Trả về kết quả ngăn cách bởi dấu phẩy.
    
    Câu hỏi: "${userQuestion}"
    Output (Chỉ các từ khóa):`;
    
    try {
        const response = await callGeminiWithRetry({ contents: [{ parts: [{ text: prompt }] }] }, getRandomStartIndex());
        let keywords = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || userQuestion;
        
        // Làm sạch và trả về
        console.log(`🧠 AI suy luận từ khóa: "${keywords}"`);
        return keywords.replace(/\n/g, " ").replace(/["']/g, "");
    } catch (e) { return userQuestion; }
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
            .textSearch('fts', `'${query}'`, { config: 'english', type: 'websearch' }) // Hoặc dùng .ilike nếu cột metadata->>title có index
            // Cách đơn giản nhất nếu chưa cấu hình FTS phức tạp là dùng ilike trên metadata
            // Dưới đây mình dùng ilike cho đơn giản và hiệu quả với tiếng Việt không dấu/có dấu
            .ilike('content', `%Tiêu đề: %${query}%`) 
            .limit(5); // Lấy 5 bài khớp tiêu đề nhất

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

// --- 6. API CHAT (BẢN FINAL: SẠCH DẤU NGOẶC + LINK TRẦN + BÁO LỖI) ---
app.post('/api/chat', async (req, res) => {
    try {
        const { question } = req.body; 
        if (!question) return res.status(400).json({ error: 'Thiếu câu hỏi.' });

        // A. TÌM KIẾM DỮ LIỆU
        const fullQuestion = dichVietTat(question);
        const searchKeywords = await aiExtractKeywords(fullQuestion);
        console.log(`🗣️ User: "${question}" -> Key: "${searchKeywords}"`);
        const documents = await searchSupabaseContext(searchKeywords);

        if (!documents) {
            return res.json({ answer: "Đệ tìm trong dữ liệu không thấy thông tin này. Mời Sư huynh tra cứu thêm tại: https://timkhaithi.pmtl.site" });
        }

        let contextString = "";
        documents.forEach((doc, index) => {
            contextString += `\n[Tài liệu ${index + 1}]\nLink: ${doc.url}\nNội dung: ${doc.content.substring(0, 1500)}...\n`;
        });

        const safetySettings = [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        ];

        // --- BƯỚC 1: PROMPT GỐC (Đã thêm lệnh CẤM dấu ngoặc) ---
        const promptGoc = `Bạn là một chuyên gia tra cứu Phật Pháp.
        
        NHIỆM VỤ CỦA BẠN:
        1. PHÂN TÍCH Ý ĐỊNH: Đọc câu hỏi của Sư huynh, xác định "Nỗi lo" hoặc "Vấn đề tâm linh" cốt lõi là gì (Ví dụ: Hỏi về "mở quán ăn" -> Ý định là lo về "nghiệp sát sinh").
        2. QUÉT DỮ LIỆU: Đọc "VĂN BẢN NGUỒN", tìm đoạn văn nào giải quyết đúng cái "Vấn đề tâm linh" đó.
        3. TRÍCH XUẤT: Copy nguyên văn đoạn đó ra.
        
        QUY TẮC BẮT BUỘC (TUÂN THỦ 100%):
        1. NGUỒN DỮ LIỆU: Chỉ sử dụng thông tin trong "VĂN BẢN NGUỒN".
        2. ĐỊNH DẠNG: Trả lời dạng gạch đầu dòng (-),KHÔNG chào hỏi, KHÔNG mở bài, KHÔNG kết luận. (Chỉ liệt kê nội dung).
        3. CẤM TUYỆT ĐỐI: Không được sử dụng dấu ngoặc vuông [ hoặc ] trong câu trả lời.
        4. TRÍCH DẪN LINK: Cuối mỗi ý quan trọng, xuống dòng và ghi: https://...

        VÍ DỤ TƯ DUY (MẪU):
        - Câu hỏi: "quên chấm nnn sau đó lỡ đốt rồi có dùng được không?"
        - Phân tích: Người hỏi muốn hỏi ngôi nhà nhỏ quên chưa chấm đủ số chấm đỏ, sau đó lại đốt đi rồi, muốn hỏi ngôi nhà nhỏ đó có tác dụng không.
        - Tìm trong văn bản: Thấy đoạn nói về "quên chấm đủ số biến kinh đã niệm trên ngôi nhà nhỏ...".
        - Kết quả: Trích dẫn đoạn "Đã đốt xong kinh văn của Ngôi Nhà Nhỏ nhưng bị thiếu dấu chấm...".
        
        --- VĂN BẢN NGUỒN ---
        ${contextString}
        --- HẾT VĂN BẢN NGUỒN ---
        
        Câu hỏi: ${fullQuestion}
        Câu trả lời:`;

        console.log("--> Đang thử Prompt Gốc...");
        let response = await callGeminiWithRetry({
            contents: [{ parts: [{ text: promptGoc }] }],
            safetySettings: safetySettings,
            generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
        }, 0);

        let aiResponse = "";
        let finishReason = "";

        if (response.data && response.data.candidates && response.data.candidates.length > 0) {
            const candidate = response.data.candidates[0];
            finishReason = candidate.finishReason;
            if (candidate.content?.parts?.[0]?.text) {
                aiResponse = candidate.content.parts[0].text;
            }
        }

        // --- BƯỚC 2: CHIẾN THUẬT CỨU NGUY (TRẢ VỀ DANH SÁCH LINK AN TOÀN) ---
        if (finishReason === "RECITATION" || !aiResponse) {
            console.log("⚠️ Prompt Gốc bị chặn (Recitation). Chuyển sang chế độ trả Link an toàn...");

            // 1. Câu thông báo cố định bạn yêu cầu
            const msgSafe = "Do hệ thống AI có giới hạn về bản quyền và truy xuất dữ liệu Quốc Tế . Sư huynh có thể lặp lại câu hỏi vài lần để có được câu trả lời chính xác nhất . Sau đây là một số bài Khai Thị của Đài Trưởng mà đệ tìm được , mong rằng sẽ giúp ích được cho Sư huynh ạ !";

            // 2. Trích xuất danh sách Link từ dữ liệu tìm kiếm (documents)
            // (Dùng Set để đảm bảo không bị trùng link)
            const uniqueLinks = [...new Set(documents.map(doc => doc.url))];
            
            // 3. Tạo danh sách link (Mỗi link 1 dòng)
            // Chỉ lấy tối đa 5 link để nhìn cho gọn
            const listLinkString = uniqueLinks.slice(0, 5).map(url => `Link : ${url}`).join('\n');

            // 4. Gán kết quả (Đây sẽ là nội dung trả về cuối cùng)
            aiResponse = `${msgSafe}\n\n${listLinkString}`;
            
            // Gửi cảnh báo nhẹ về Telegram để admin biết bài này đang bị Google chặn bản quyền
            if (typeof sendTelegramAlert === 'function') {
                // Không await để không làm chậm phản hồi người dùng
                sendTelegramAlert(`⚠️ <b>Recitation Blocked:</b>\nQuestion: ${fullQuestion}\n-> Đã trả về danh sách Link an toàn.`);
            }
        }

        // =================================================================================
        // BƯỚC QUAN TRỌNG NHẤT: BỘ LỌC RÁC CUỐI CÙNG
        // =================================================================================
        
        // 1. Xóa sạch dấu [ và ] ở bất kỳ đâu trong văn bản
        aiResponse = aiResponse.replace(/[\[\]]/g, ""); 
        
        // 2. Định nghĩa câu chào của bạn
        const fixedIntro = "Kính thưa Sư Huynh ! sau đây là các khai thị của Đài Trưởng Lư đệ có tìm được. Mong rằng các khai thị này sẽ hữu ích cho Sư huynh ạ !\n\n";
        
        // =================================================================================

        let finalAnswer = "";
        if (aiResponse.includes("mucluc.pmtl.site") || aiResponse.includes("NONE")) {
             finalAnswer = "Mời Sư huynh tra cứu thêm tại mục lục tổng quan : https://mucluc.pmtl.site .";
        } else {
            aiResponse = aiResponse.replace(/\*\*Phụng Sự Viên Ảo Trả Lời :\*\*/g, "").trim();
            finalAnswer = "**Phụng Sự Viên Ảo Trả Lời:**\n\n" + aiResponse + "\n\n**Nhắc nhở: Sư huynh kiểm tra thêm tại: https://timkhaithi.pmtl.site **";
        }

        res.json({ answer: finalAnswer });

    } catch (error) {
        console.error("Error:", error.message);
        // Báo lỗi Telegram
        if (typeof sendTelegramAlert === 'function') {
             await sendTelegramAlert(`❌ LỖI CHAT:\n${error.message}`);
        }
        res.status(503).json({ answer: "Lỗi hệ thống." });
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

app.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
