import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

export default async function handler(req, res) {
  const { cert } = req.query;
  if (!cert) return res.status(400).json({ error: 'Cert ID required' });

  // --- CONFIG CHECK ---
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  const psaToken = process.env.PSA_API_TOKEN;
  const chKey = process.env.CARD_HEDGE_API_KEY;

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

    // --- 2. FETCH PSA DATA (Critical Step) ---
    // If this fails, we stop because we don't know what card it is.
    if (!psaToken) throw new Error("Missing PSA_API_TOKEN");

    const psaResponse = await axios.get(
      `https://api.psacard.com/publicapi/cert/GetByCertNumber/${cert}`,
      { headers: { 'Authorization': `Bearer ${psaToken}` } }
    );
    const psaData = psaResponse.data;
    const cardInfo = psaData.PSACert || psaData.Cert;

    if (!psaData || !cardInfo) {
        return res.status(404).json({ error: "Card not found in PSA database" });
    }

    // --- 3. FETCH SALES DATA (Optional Step) ---
    // We wrap this in its OWN try/catch. If it fails, we still return the PSA card data.
    let salesData = [];
    try {
        // CORRECT URL: api.cardhedger.com (added 'r')
        const searchString = `${cardInfo.Year} ${cardInfo.Brand} ${cardInfo.Subject} PSA ${cardInfo.CardGrade}`;
        console.log(`Searching Sales for: ${searchString}`);

        const chResponse = await axios.get(
          `https://api.cardhedger.com/v1/sales/search`, 
          { 
            params: { q: searchString },
            headers: { 'X-API-KEY': chKey } 
          }
        );
        salesData = chResponse.data.data || [];
        
    } catch (salesError) {
        // Log the error but DO NOT CRASH. Just send back empty sales.
        console.error("Sales Lookup Failed:", salesError.message);
        salesData = []; 
    }

    // --- 4. SAVE TO CACHE ---
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
        details: error.response ? error.response.data : error.message 
    });
  }
}
