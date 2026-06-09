import QRCode from 'qrcode';

// Dados PIX estáticos
const PIX_KEY = process.env.PIX_KEY || '13996666432';
const PIX_NAME = process.env.PIX_NAME || 'MATHEUS LINS LIMA';
const PIX_CITY = process.env.PIX_CITY || 'PRAIA GRANDE';

// CRC16 CCITT (para payload PIX)
function crc16(str) {
  let crc = 0xFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) crc = (crc << 1) ^ 0x1021;
      else crc <<= 1;
    }
    crc &= 0xFFFF;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function tlv(id, value) {
  const len = value.length.toString().padStart(2, '0');
  return `${id}${len}${value}`;
}

// Gera payload PIX EMV estático
export function generatePixPayload(amount) {
  const amountStr = amount.toFixed(2);
  // Merchant Account Info (chave PIX)
  const mai = tlv('00', 'BR.GOV.BCB.PIX') + tlv('01', PIX_KEY);
  let payload = '';
  payload += tlv('00', '01'); // Payload Format Indicator
  payload += tlv('26', mai); // Merchant Account Information
  payload += tlv('52', '0000'); // MCC
  payload += tlv('53', '986'); // Currency (BRL)
  payload += tlv('54', amountStr); // Amount
  payload += tlv('58', 'BR'); // Country
  payload += tlv('59', PIX_NAME.slice(0, 25)); // Merchant Name
  payload += tlv('60', PIX_CITY.slice(0, 15)); // Merchant City
  payload += tlv('62', tlv('05', '***')); // Additional Data (txid)
  // CRC placeholder
  payload += '6304';
  const crc = crc16(payload);
  payload += crc;
  return payload;
}

// Gera QR Code como data URL (base64 PNG)
export async function generatePixQRCode(amount) {
  const payload = generatePixPayload(amount);
  const dataUrl = await QRCode.toDataURL(payload, { width: 300, margin: 2 });
  return { payload, qrDataUrl: dataUrl };
}
