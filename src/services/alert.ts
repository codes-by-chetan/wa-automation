import { exec } from 'child_process';
import os from 'os';
import { WASocket } from '@whiskeysockets/baileys';
import { db } from '../storage/db';

/**
 * Play a ringing telephone sound or alarm to alert and wake up the user
 */
export function playAlertSound(isUrgent = false): void {
  try {
    // 1. Terminal bell beep
    process.stdout.write('\x07');

    const platform = os.platform();

    if (platform === 'win32') {
      // For urgent wake-up calls, play the realistic phone ringtone Ring01.wav or Alarm01.wav
      const soundFile = isUrgent
        ? "C:\\Windows\\Media\\Ring01.wav"
        : "C:\\Windows\\Media\\notify.wav";

      const psCommand = `
        $file = '${soundFile}';
        if (Test-Path $file) {
          $player = New-Object Media.SoundPlayer $file;
          ${isUrgent ? '1..3 | ForEach-Object { $player.PlaySync(); Start-Sleep -Milliseconds 600 }' : '$player.PlaySync()'}
        } else {
          ${isUrgent ? '1..4 | ForEach-Object { [console]::beep(1200, 400); [console]::beep(800, 300); Start-Sleep -Milliseconds 200 }' : '[console]::beep(1000, 500)'}
        }
      `.replace(/\r?\n/g, ' ');

      exec(`powershell -NoProfile -Command "${psCommand}"`, (err) => {
        if (err) {
          exec(`powershell -NoProfile -Command "[console]::beep(1000, 400)"`);
        }
      });
    } else if (platform === 'darwin') {
      exec('afplay /System/Library/Sounds/Glass.aiff');
    } else {
      exec('paplay /usr/share/sounds/freedesktop/stereo/complete.oga || aplay /usr/share/sounds/alsa/Front_Center.wav');
    }
  } catch (err) {
    console.error('[AlertService] Failed to play alert sound:', err);
  }
}

export interface EmergencyAlertOptions {
  ownerName: string;
  senderName: string;
  senderJid: string;
  incomingText: string;
  sock?: WASocket | null;
  emergencyNumberOverride?: string;
  callmebotApiKeyOverride?: string;
}

/**
 * Execute full emergency protocol:
 * 1. Play loud phone ringtone on device.
 * 2. Send high-priority WhatsApp SOS message to configured emergency number.
 * 3. Trigger optional external Voice Call / Webhook URL if configured.
 * 4. Log alert to system database.
 */
export async function triggerEmergencyAlert(options: EmergencyAlertOptions): Promise<void> {
  const settings = db.getSettings();
  const emergencyNumber = (options.emergencyNumberOverride || settings.emergency_number || process.env.EMERGENCY_NUMBER || '').trim();
  const webhookUrl = (settings.emergency_call_webhook || process.env.EMERGENCY_CALL_WEBHOOK_URL || '').trim();

  const callmebotApiKey = (options.callmebotApiKeyOverride || settings.callmebot_api_key || process.env.CALLMEBOT_API_KEY || '').trim();

  // 1. Play loud ringing sound on the device
  playAlertSound(true);

  // Auto-construct CallMeBot Voice Call URL if API key is provided and no custom webhook
  let activeCallUrl = webhookUrl;
  if (!activeCallUrl && callmebotApiKey && emergencyNumber) {
    const formattedPhone = emergencyNumber.startsWith('+') ? emergencyNumber : `+${emergencyNumber.replace(/\D/g, '')}`;
    const cleanSpeech = encodeURIComponent(`Urgent wake up alert for ${options.ownerName}. ${options.senderName} says: ${options.incomingText.slice(0, 80)}`);
    activeCallUrl = `https://api.callmebot.com/call.php?phone=${formattedPhone}&text=${cleanSpeech}&apikey=${callmebotApiKey}`;
  }

  const alertHeader = `🚨 [URGENT WAKE-UP EMERGENCY ALERT] 🚨`;
  const timeStr = new Date().toLocaleTimeString();

  console.log(`\n======================================================`);
  console.log(`${alertHeader}`);
  console.log(`From: ${options.senderName} (${options.senderJid})`);
  console.log(`Message: "${options.incomingText}"`);
  console.log(`Time: ${timeStr}`);
  if (emergencyNumber) console.log(`Emergency Number: ${emergencyNumber}`);
  if (activeCallUrl) console.log(`Placing Voice Call via: ${activeCallUrl.replace(/apikey=[^&]+/, 'apikey=***')}`);
  console.log(`======================================================\n`);

  // 2. Dispatch urgent WhatsApp notification to the emergency contact (only if sender is a different person)
  if (emergencyNumber && options.sock) {
    let targetJid = emergencyNumber;
    if (!targetJid.includes('@')) {
      const digits = targetJid.replace(/\D/g, '');
      targetJid = `${digits}@s.whatsapp.net`;
    }

    const emergencyDigits = emergencyNumber.replace(/\D/g, '');
    const isSenderEmergencyContact = emergencyDigits.length > 5 && options.senderJid.includes(emergencyDigits);

    if (!isSenderEmergencyContact) {
      const sosMessage = 
        `🚨 *[EMERGENCY WAKE-UP ALERT]* 🚨\n\n` +
        `Someone urgently requested to wake up *${options.ownerName}*!\n\n` +
        `• *From:* ${options.senderName} (${options.senderJid.split('@')[0]})\n` +
        `• *Message:* "${options.incomingText}"\n` +
        `• *Time:* ${timeStr}\n\n` +
        `⚠️ *Please wake up and attend to this immediately!*`;

      try {
        await options.sock.sendMessage(targetJid, { text: sosMessage });
        db.log('ALERT', `Emergency WhatsApp SOS dispatched to ${emergencyNumber}`, {
          to: emergencyNumber,
          from: options.senderName,
          message: options.incomingText,
        });
      } catch (err: any) {
        console.error('[AlertService] Failed to send emergency WhatsApp message:', err);
        db.log('ERROR', `Failed to send emergency WhatsApp alert to ${emergencyNumber}`, {
          error: err?.message,
        });
      }
    } else {
      console.log(`[AlertService] Sender is the emergency contact (${options.senderJid}); skipped duplicate SOS text message.`);
    }
  }

  // 3. Trigger Phone Call API (CallMeBot or Custom Webhook)
  if (activeCallUrl) {
    try {
      const isGetMethod = activeCallUrl.includes('?') || activeCallUrl.toLowerCase().includes('callmebot');
      if (isGetMethod) {
        const urlObj = new URL(activeCallUrl);
        // Only set text if not already present
        if (!urlObj.searchParams.get('text')) {
          urlObj.searchParams.set('text', `Urgent wake up alert for ${options.ownerName}`);
        }
        console.log(`[AlertService] Requesting phone call from: ${urlObj.origin}${urlObj.pathname}...`);
        const resp = await fetch(urlObj.toString());
        const bodyText = await resp.text();
        console.log(`[AlertService] Voice call provider responded:`, bodyText.slice(0, 200));
        db.log('ALERT', `Voice call provider response: ${bodyText.slice(0, 200)}`);
      } else {
        // Standard JSON POST webhook (Twilio, Zapier, etc.)
        const resp = await fetch(activeCallUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'EMERGENCY_WAKEUP_ALERT',
            owner: options.ownerName,
            sender: options.senderName,
            senderJid: options.senderJid,
            message: options.incomingText,
            emergencyNumber,
            timestamp: new Date().toISOString(),
          }),
        });
        const respText = await resp.text();
        db.log('ALERT', `Voice Call Webhook triggered successfully: ${respText.slice(0, 200)}`);
      }
    } catch (err: any) {
      console.error('[AlertService] Failed to trigger emergency call:', err);
      db.log('ERROR', `Failed to place emergency call: ${activeCallUrl}`, { error: err?.message });
    }
  } else {
    console.log('[AlertService] Notice: No CALLMEBOT_API_KEY or EMERGENCY_CALL_WEBHOOK_URL set. To make your phone ring with a call, configure CallMeBot API key or call webhook.');
  }

  db.log('ALERT', `🔔 Urgent wake-up alert triggered for ${options.ownerName}! Message from ${options.senderName}: "${options.incomingText}"`, {
    sender: options.senderName,
    message: options.incomingText,
    emergencyNumber: emergencyNumber || 'None configured',
  });
}
