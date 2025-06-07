const fetch = require('node-fetch');

async function sendWebhook(webhookUrl, data) {
  if (!webhookUrl) return;
  
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      timeout: 10000 // 10 second timeout
    });
    
    if (response.ok) {
      console.log(`✅ Webhook sent successfully for ID ${data.id}`);
    } else {
      console.error(`❌ Webhook failed with status ${response.status}`);
    }
  } catch (error) {
    console.error('❌ Webhook error:', error.message);
  }
}

module.exports = { sendWebhook };