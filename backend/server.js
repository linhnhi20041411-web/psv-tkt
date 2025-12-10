// server.js - Phiên bản Hybrid: Vector + Keyword + URL Priority (Siêu chính xác)

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// --- CẤU HÌNH ---
const rawKeys = process.env.GEMINI_API_KEYS || "";
const apiKeys = rawKeys.split(',').map(key => key.trim()).filter(key => key.length > 0);

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) console.error("❌ LỖI: Thiếu cấu hình Supabase");
const supabase = createClient(supabaseUrl, supabaseKey);

function getRandomKey() {
    return apiKeys[Math.floor(Math.random() * apiKeys.length)];
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function callGeminiWithRetry(payload, keyIndex = 0, retryCount = 0) {
    if (keyIndex >= apiKeys.length) {
        if (retryCount < 1) {
            await sleep(2000);
            return callGeminiWithRetry(payload, 0, retryCount + 1);
        }
        throw new Error("ALL_KEYS_EXHAUSTED");
    }
    const currentKey = apiKeys[keyIndex];
    const model = "gemini-2.5-flash-lite"; 
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${currentKey}`;

    try {
        const response = await axios.post(apiUrl, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 60000 
        });
        return response;
    } catch (error) {
        const status = error.response ? error.response.status : 0;
        if (status === 429 || status === 400 || status === 403 || status >= 500) {
            if (status === 429) await sleep(1000); 
            return callGeminiWithRetry(payload, keyIndex + 1, retryCount);
        }
        throw error;
    }
}

// --- HÀM 1: PHÂN TÍCH TỪ KHÓA & SLUG URL ---
// Chuyển câu hỏi thành dạng không dấu để tìm trong URL (Ví dụ: "phóng sinh tối" -> "phong sinh")
function removeVietnameseTones(str) {
    str = str.replace(/à|á|ạ|ả|ã|â|ầ|ấ|ậ|ẩ|ẫ|ă|ằ|ắ|ặ|ẳ|ẵ/g,"a"); 
    str = str.replace(/è|é|ẹ|ẻ|ẽ|ê|ề|ế|ệ|ể|ễ/g,"e"); 
    str = str.replace(/ì|í|ị|ỉ|ĩ/g,"i"); 
    str = str.replace(/ò|ó|ọ|ỏ|õ|ô|ồ|ố|ộ|ổ|ỗ|ơ|ờ|ớ|ợ|ở|ỡ/g,"o"); 
    str = str.replace(/ù|ú|ụ|ủ|ũ|ư|ừ|ứ|ự|ử|ữ/g,"u"); 
    str = str.replace(/ỳ|ý|ỵ|ỷ|ỹ/g,"y"); 
    str = str.replace(/đ/g,"d");
    return str;
}

async function analyzeQuery(originalQuestion) {
    try {
        const prompt = `Phân tích câu hỏi tìm kiếm.
        1. Viết lại dùng từ ngữ Phật học (tối -> ban đêm, làm thịt -> sát sanh).
        2. Trích xuất từ khóa quan trọng (Keywords).
        3. Tạo từ khóa dạng không dấu (Slug) để tìm trong URL.
        
        Trả về JSON:
        {
          "rewritten": "câu hỏi mới",
          "keywords": ["từ khóa 1", "từ khóa 2"],
          "slug_keywords": ["tu khoa khong dau"]
        }
        
        Câu gốc: "${originalQuestion}"`;

        const response = await callGeminiWithRetry({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
        }, 0);

        const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        return JSON.parse(text);
    } catch (e) {
        // Fallback thủ công nếu AI lỗi
        const noAccent = removeVietnameseTones(originalQuestion.toLowerCase());
        return { 
            rewritten: originalQuestion, 
            keywords: [originalQuestion], 
            slug_keywords: noAccent.split(" ").filter(w => w.length > 2) 
        };
    }
}

// --- HÀM 2: TÌM KIẾM TRONG URL (QUAN TRỌNG NHẤT) ---
async function searchByUrl(slugKeywords) {
    if (!slugKeywords || slugKeywords.length === 0) return [];
    try {
        // Tìm bài viết mà URL có chứa các từ khóa không dấu
        // Ví dụ: URL 'co-phong-sinh-vao-ban-em' sẽ khớp với 'phong', 'sinh', 'ban', 'dem'
        let query = supabase.from('vn_buddhism_content').select('content, url').limit(5);
        
        // Lấy 2 từ khóa quan trọng nhất để tìm trong URL
        const mainSlugs = slugKeywords.slice(0, 2); 
        
        mainSlugs.forEach(slug => {
            query = query.ilike('url', `%${slug}%`);
        });

        const { data, error } = await query;
        if (data && data.length > 0) {
            console.log(`🎯 URL Search trúng ${data.length} bài! (URL: ${data[0].url})`);
        }
        return data || [];
    } catch (e) { return []; }
}

// --- HÀM 3: TÌM KIẾM VECTOR ---
async function searchVector(query) {
    try {
        const genAI = new GoogleGenerativeAI(getRandomKey());
        const model = genAI.getGenerativeModel({ model: "text-embedding-004"});
        const result = await model.embedContent(query);
        const { data } = await supabase.rpc('match_documents', {
            query_embedding: result.embedding.values,
            match_threshold: 0.25, 
            match_count: 5
        });
        return data || [];
    } catch (e) { return []; }
}

app.post('/api/chat', async (req, res) => {
    try {
        const { question } = req.body; 
        if (!question) return res.status(400).json({ error: 'Thiếu câu hỏi.' });

        console.log(`\n=== USER HỎI: "${question}" ===`);
        
        // 1. Phân tích
        const analysis = await analyzeQuery(question);
        console.log(`🔍 Bot hiểu: ${analysis.rewritten}`);

        // 2. CHẠY 2 CHIẾN THUẬT SONG SONG
        // Chiến thuật A: Tìm trong URL (Bắt dính bài viết chính xác)
        // Chiến thuật B: Tìm Vector (Tìm theo ý nghĩa)
        const [urlResults, vectorResults] = await Promise.all([
            searchByUrl(analysis.slug_keywords),
            searchVector(analysis.rewritten)
        ]);

        // 3. Gộp kết quả (Ưu tiên URL lên đầu tiên)
        const combinedMap = new Map();
        
        // Nạp kết quả URL trước (Ưu tiên số 1)
        urlResults.forEach(item => combinedMap.set(item.url, item));
        // Nạp kết quả Vector sau
        vectorResults.forEach(item => {
            if (!combinedMap.has(item.url)) combinedMap.set(item.url, item);
        });

        const finalData = Array.from(combinedMap.values()).slice(0, 5);

        // --- XỬ LÝ KHÔNG TÌM THẤY ---
        if (finalData.length === 0) {
            return res.json({ 
                answer: `Đệ tìm không thấy thông tin này.<br><br>Sư huynh tra cứu tại: <a href="https://mucluc.pmtl.site" target="_blank">mucluc.pmtl.site</a>` 
            });
        }

        const topUrl = finalData[0].url; 
        const contextText = finalData.map(doc => doc.content).join("\n\n---\n\n");

        console.log(`✅ Chốt bài viết: ${topUrl}`); // Xem log để biết nó chọn bài nào

        // 4. Gọi Gemini
        const promptGoc = `Bạn là trợ lý ảo Phật giáo.
        Dữ liệu tham khảo:
        ---
        ${contextText}
        ---
        Câu hỏi: "${analysis.rewritten}"
        Yêu cầu: Trả lời ngắn gọn, đúng trọng tâm. Ưu tiên thông tin từ bài viết có tiêu đề khớp với câu hỏi nhất.`;

        let response = await callGeminiWithRetry({
            contents: [{ parts: [{ text: promptGoc }] }],
            generationConfig: { temperature: 0.3 }
        }, 0);

        let aiResponse = "";
        if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
            aiResponse = response.data.candidates[0].content.parts[0].text;
        }

        let finalAnswer = "**Phụng Sự Viên Ảo Trả Lời:**\n\n" + aiResponse;

        if (topUrl && topUrl.startsWith('http')) {
            finalAnswer += `\n\n<br><a href="${topUrl}" target="_blank" style="display:inline-block; background-color:#b45309; color:white; padding:10px 20px; border-radius:20px; text-decoration:none; font-weight:bold; margin-top:10px;">👉 Xem Thêm Chi Tiết</a>`;
        }

        res.json({ answer: finalAnswer });

    } catch (error) {
        console.error("Lỗi:", error);
        res.status(500).json({ error: "Lỗi hệ thống." });
    }
});

app.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
