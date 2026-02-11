import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

// Silence warnings
process.removeAllListeners('warning');

export default async function handler(req, res) {
  const { cert } = req.query;
  if (!cert) return res.status(400).json({ error: 'Cert ID required' });

  // --- CONFIG ---
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  const psaToken = process.env.PSA_API_TOKEN;
  const chKey = process.env.CARD_HEDGE_API_KEY;

  if (!supabaseUrl || !supabaseUrl.startsWith('http')) {
    return res.status(500).json({ error: 'Configuration Error: SUPABASE_URL missing' });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    // 1. CACHE CHECK
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

    // 2. PSA LOOKUP
    if (!psaToken) throw new Error("Missing PSA_API_TOKEN");

    console.log(`[PSA] Fetching Cert: ${cert}`);
    const psaResponse = await axios.get(
      `https://api.psacard.com/publicapi/cert/GetByCertNumber/${cert}`,
      { headers: { 'Authorization': `Bearer ${psaToken}` } }
    );
    const psaData = psaResponse.data;
    const cardInfo = psaData.PSACert || psaData.Cert;

    if (!psaData || !cardInfo) {
        return res.status(404).json({ error: "Card not found in PSA database" });
    }

    // 3. SALES LOOKUP (Fixed to POST)
    let salesData = [];
    try {
        const searchString = `${cardInfo.Year} ${cardInfo.Brand} ${cardInfo.Subject} PSA ${cardInfo.CardGrade}`;
        console.log(`[Sales] POSTing Search: ${searchString}`);

        // FIX: Switched to POST because of 405 error
        const chResponse = await axios.post(
          `https://api.cardhedger.com/v1/cards/card-search`, 
          { 
             search: searchString // Sending search term in body
          },
          { 
            headers: { 
                'X-API-KEY': chKey,
                'Content-Type': 'application/json'
            },
            timeout: 8000
          }
        );

        console.log(`[Sales] Status: ${chResponse.status}`);
        
        // Handle response structure (items vs data)
        const rawData = chResponse.data;
        // Sometimes APIs return { items: [...] } or { data: [...] }
        salesData = rawData.items || rawData.data || rawData || [];

        console.log(`[Sales] Found ${salesData.length} records`);

    } catch (salesError) {
        console.warn("[Sales] FAILED:", salesError.message);
        if (salesError.response) {
            console.warn("[Sales] API Status:", salesError.response.status);
            console.warn("[Sales] API Data:", JSON.stringify(salesError.response.data));
        }
        salesData = []; 
    }

    // 4. SAVE & RETURN
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
    console.error("Critical Backend Error:", error.message);
    return res.status(500).json({ 
        error: 'Backend Error', 
        details: error.message 
    });
  }
}
