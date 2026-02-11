import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

export default async function handler(req, res) {
  const { cert } = req.query;
  if (!cert) return res.status(400).json({ error: 'Cert ID required' });

  // --- CONFIG CHECK ---
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  
  if (!supabaseUrl || !supabaseUrl.startsWith('http')) {
    return res.status(500).json({ error: 'Configuration Error: SUPABASE_URL missing' });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    // --- 1. CACHE CHECK ---
    const { data: cachedRow } = await supabase
      .from('cached_cards')
      .select('*')
      .eq('cert_id', cert)
      .single();

    if (cachedRow) {
      const daysOld = (new Date() - new Date(cachedRow.last_updated)) / (1000 * 60 * 60 * 24);
      if (daysOld < 7) {
        return res.status(200).json({ 
          source: 'cache', 
          psa: cachedRow.card_data, 
          sales: cachedRow.sales_data 
        });
      }
    }

    // --- 2. API FETCH ---
    if (!process.env.PSA_API_TOKEN) throw new Error("Missing PSA_API_TOKEN");

    // Call PSA
    const psaResponse = await axios.get(
      `https://api.psacard.com/publicapi/cert/GetByCertNumber/${cert}`,
      { headers: { 'Authorization': `Bearer ${process.env.PSA_API_TOKEN}` } }
    );
    const psaData = psaResponse.data;

    // *** FIX: Check for 'PSACert' instead of 'Cert' ***
    const cardInfo = psaData.PSACert || psaData.Cert; // Handle both potential formats

    if (!psaData || !cardInfo) {
        console.error("PSA API returned invalid data:", psaData);
        return res.status(404).json({ error: "Card not found in PSA database" });
    }

    // *** FIX: Use 'cardInfo' variable for easier reading ***
    // Search String: "2018 TOPPS UPDATE SHOHEI OHTANI PSA GEM MT 10"
    const searchString = `${cardInfo.Year} ${cardInfo.Brand} ${cardInfo.Subject} PSA ${cardInfo.CardGrade}`;
    
    console.log("Searching CardHedge for:", searchString); // Helpful debug log

    const chResponse = await axios.get(
      `https://api.cardhedge.com/v1/sales/search`, 
      { 
        params: { q: searchString },
        headers: { 'X-API-KEY': process.env.CARD_HEDGE_API_KEY } 
      }
    );
    const salesData = chResponse.data.data || [];

    // --- 3. SAVE TO CACHE ---
    await supabase.from('cached_cards').upsert({
      cert_id: cert,
      card_data: psaData,
      sales_data: salesData,
      last_updated: new Date().toISOString()
    });

    return res.status(200).json({ 
      source: 'api', 
      psa: psaData, 
      sales: salesData 
    });

  } catch (error) {
    console.error("Backend Error:", error.message);
    return res.status(500).json({ 
        error: 'Backend Error', 
        details: error.response ? error.response.data : error.message 
    });
  }
}
