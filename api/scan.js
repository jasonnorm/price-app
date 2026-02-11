// /api/scan.js
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

// 1. Silence the Node.js Deprecation Warning so we can see real errors
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
    console.error("Config Error: Invalid Supabase URL");
    return res.status(500).json({ error: 'Configuration Error' });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    // --- STEP 1: CACHE CHECK ---
    const { data: cachedRow } = await supabase
      .from('cached_cards')
      .select('*')
      .eq('cert_id', cert)
      .single();

    if (cachedRow) {
      // Return cached data if valid
      const daysOld = (new Date() - new Date(cachedRow.last_updated)) / (1000 * 60 * 60 * 24);
      if (daysOld < 7) {
        return res.status(200).json({ 
          source: 'cache', 
          psa: cachedRow.card_data, 
          sales: cachedRow.sales_data 
        });
      }
    }

    // --- STEP 2: PSA LOOKUP ---
    if (!psaToken) throw new Error("Missing PSA_API_TOKEN");

    console.log(`[PSA] Fetching Cert: ${cert}`);
    
    // We use a specific User-Agent to avoid being blocked
    const psaResponse = await axios.get(
      `https://api.psacard.com/publicapi/cert/GetByCertNumber/${cert}`,
      { 
        headers: { 
            'Authorization': `Bearer ${psaToken}`,
            'User-Agent': 'Mozilla/5.0' 
        } 
      }
    );
    
    const psaData = psaResponse.data;
    // Handle both new and old PSA API formats
    const cardInfo = psaData.PSACert || psaData.Cert;

    if (!psaData || !cardInfo) {
        console.warn("[PSA] No card info found in response");
        return res.status(404).json({ error: "Card not found in PSA database" });
    }

    // --- STEP 3: SALES LOOKUP (Card Hedger) ---
    let salesData = [];
    try {
        const searchString = `${cardInfo.Year} ${cardInfo.Brand} ${cardInfo.Subject} PSA ${cardInfo.CardGrade}`;
        console.log(`[Sales] Searching: ${searchString}`);

        // CORRECT URL: cardhedger.com (with 'r')
        // We try GET first as it's standard for search queries
        const chResponse = await axios.get(
            `https://api.cardhedger.com/v1/cards/card-search`, 
            { 
                params: { 
                    q: searchString, // Common search param
                    search: searchString // Alternate search param
                },
                headers: { 
                    'X-API-KEY': chKey,
                    'Accept': 'application/json'
                },
                timeout: 5000 // 5s timeout to prevent hanging
            }
        );

        // Safely extract data regardless of API wrapper (data.data, data.items, etc.)
        const rawData = chResponse.data;
        salesData = Array.isArray(rawData) ? rawData : (rawData.data || rawData.items || []);
        
        console.log(`[Sales] Found ${salesData.length} records`);

    } catch (salesError) {
        // NON-FATAL ERROR: We log it, but we DO NOT crash.
        // We proceed so the user at least gets the PSA Card details.
        console.error(`[Sales] Lookup Failed: ${salesError.message}`);
        
        if (salesError.response) {
             // Log detailed API error if available (404, 401, 500)
             console.error(`[Sales] API Status: ${salesError.response.status}`);
        }
        salesData = []; // Fallback to empty
    }

    // --- STEP 4: SAVE TO CACHE ---
    await supabase.from('cached_cards').upsert({
      cert_id: cert,
      card_data: psaData,
      sales_data: salesData,
      last_updated: new Date().toISOString()
    });

    // --- STEP 5: RETURN SUCCESS ---
    return res.status(200).json({ 
      source: 'api', 
      psa: psaData, 
      sales: salesData 
    });

  } catch (error) {
    // CRITICAL ERROR CATCHER
    console.error("CRITICAL FUNCTION ERROR:", error.message);
    return res.status(500).json({ 
        error: 'Backend Failure', 
        details: error.message 
    });
  }
}
