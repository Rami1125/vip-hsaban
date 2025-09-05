// --- CONFIGURATION ---
const SPREADSHEET_ID = '1MWddIt62VP3NTEv8-LNrWm-x95kz3D_Wt9VBScRDjl8';
const SS = SpreadsheetApp.openById(SPREADSHEET_ID);

// Admin Users (Hardcoded for security)
const ADMIN_USERS = {
  'saban@saban.co.il': '123456'
};

// Sheet Names
const SHEETS = {
  CLIENTS: 'לקוחות',
  PROJECTS: 'פרויקטים',
  ORDERS: 'הזמנות',
  CONTAINER_TRACKING: 'מעקב מכולות',
  PRODUCT_CATALOG: 'קטלוג מוצרים',
  MUNICIPAL_GUIDELINES: 'הנחיות מוניציפליות',
  PUSH_SUBSCRIPTIONS: 'רישום התראות Push',
  CHAT: 'תקשורת (צ\'אט)',
  AUDIT_LOG: 'יומן ביקורת (AuditLog)'
};

// --- ROUTING ---
function doGet(e) {
  try {
    const view = e.parameter.view || 'client';
    if (view === 'admin') {
      return HtmlService.createHtmlOutputFromFile('admin')
        .setTitle('מערכת ניהול VIP')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }
    return HtmlService.createHtmlOutputFromFile('client')
      .setTitle('מערכת VIP ח. סבן')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (err) {
    return ContentService.createTextOutput("Apps Script endpoint is active. HTML files should be run locally for development.");
  }
}

// ... (חלק עליון של הקוד) ...

// NEW: Function to handle preflight OPTIONS requests for CORS
function doOptions(e) {
  return ContentService.createTextOutput()
    .setHeader('Access-Control-Allow-Origin', '*')
    .setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    .setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function doPost(e) {
  // This structure handles all API calls robustly.
  try {
    const request = JSON.parse(e.postData.contents);
    const action = request.action;
    const payload = request.payload;
    let responseData;

    switch (action) {
      case 'authenticateUser':
        responseData = authenticateUser(payload.phone, payload.password);
        break;
      case 'authenticateAdmin':
        responseData = authenticateAdmin(payload.email, payload.password);
        break;
      case 'getInitialData':
        responseData = getInitialData(payload.userId);
        break;
      case 'createOrder':
        responseData = createOrder(payload.orderData);
        break;
      default:
        throw new Error(`Invalid action: ${action}`);
    }
    
    return ContentService.createTextOutput(JSON.stringify(responseData))
      .setMimeType(ContentService.MimeType.JSON)
      .setHeader('Access-Control-Allow-Origin', '*');

  } catch (error) {
    logAction('system', 'error -> doPost', { error: error.message, requestBody: e.postData.contents });
    const errorResponse = { success: false, error: error.message };
    return ContentService.createTextOutput(JSON.stringify(errorResponse))
      .setMimeType(ContentService.MimeType.JSON)
      .setHeader('Access-Control-Allow-Origin', '*');
  }
}

// --- UTILITY FUNCTIONS ---
function normalizePhoneNumber(phone) {
  if (!phone) return '';
  return String(phone).replace(/\D/g, '').slice(-9);
}

// --- AUTHENTICATION & DATA FETCHING ---
function authenticateUser(phone, password) {
    const clientsSheet = SS.getSheetByName(SHEETS.CLIENTS);
    const data = clientsSheet.getDataRange().getValues();
    const headers = data.shift();
    
    const phoneIndex = headers.indexOf('מספר טלפון');
    const passwordIndex = headers.indexOf('סיסמה');
    const normalizedPhoneToFind = normalizePhoneNumber(phone);

    for (const row of data) {
        const normalizedSheetPhone = normalizePhoneNumber(row[phoneIndex]);
        if (normalizedSheetPhone === normalizedPhoneToFind && String(row[passwordIndex]).trim() === String(password).trim()) {
            const user = headers.reduce((obj, header, i) => {
                obj[header] = row[i];
                return obj;
            }, {});
            delete user.סיסמה;
            logAction(user['מזהה לקוח'], 'login', { success: true });
            updateLastSeen(user['מזהה לקוח']);
            return { success: true, user: user };
        }
    }
    logAction(phone, 'login failed', {});
    return { success: false, error: 'Invalid credentials' };
}

function authenticateAdmin(email, password) {
  if (ADMIN_USERS[email] && ADMIN_USERS[email].trim() === password.trim()) {
    const adminName = email.split('@')[0];
    logAction(email, 'admin login success', {});
    return { success: true, user: { name: adminName, email: email } };
  } else {
    logAction(email, 'admin login failed', {});
    return { success: false, error: 'Invalid admin credentials' };
  }
}

function getInitialData(userId) {
  try {
    updateLastSeen(userId);
    const projectsSheet = SS.getSheetByName(SHEETS.PROJECTS);
    const ordersSheet = SS.getSheetByName(SHEETS.ORDERS);
    
    const projects = sheetToObjects(projectsSheet).filter(p => String(p['מזהה לקוח']).trim() == String(userId).trim());
    const orders = sheetToObjects(ordersSheet).filter(o => String(o['מספר לקוח']).trim() == String(userId).trim());

    return { success: true, data: { projects, orders } };
  } catch (error) {
    logAction(userId, 'getInitialData failed', { error: error.message });
    return { success: false, error: error.message };
  }
}

// --- ORDER MANAGEMENT ---
function createOrder(orderData) {
  try {
    const ordersSheet = SS.getSheetByName(SHEETS.ORDERS);
    const headers = ordersSheet.getRange(1, 1, 1, ordersSheet.getLastColumn()).getValues()[0];
    const newOrderId = `ORD-${Utilities.getUuid().slice(0, 8)}`;
    const now = new Date();

    const newRow = headers.map(header => {
        switch(header) {
            case 'מזהה הזמנה': return newOrderId;
            case 'מספר לקוח': return orderData.clientId;
            case 'פרויקט': return orderData.projectId;
            case 'סוג הזמנה': return orderData.orderType;
            case 'קטגוריית סטטוס': return 'backlog';
            case 'סוג פעולה': return orderData.actionType || '';
            case 'תאריך הזמנה': return orderData.preferredDate;
            case 'סטטוס': return 'ממתין לאישור';
            case 'פריטים': return JSON.stringify(orderData.items || []);
            case 'created_at (תאריך יצירה)': return now;
            case 'updated_at (תאריך עדכון': return now;
            case 'modified_by': return orderData.clientName;
            default: return '';
        }
    });

    ordersSheet.appendRow(newRow);
    logAction(orderData.clientId, 'createOrder', { orderId: newOrderId, type: orderData.orderType });
    return { success: true, orderId: newOrderId };

  } catch(error) {
    logAction(orderData.clientId, 'createOrder failed', { error: error.message });
    return { success: false, error: error.message };
  }
}

// --- DATA CONVERSION UTILITY ---
function sheetToObjects(sheet) {
    const data = sheet.getDataRange().getValues();
    const headers = data.shift();
    return data.map(row => {
        const obj = {};
        headers.forEach((header, i) => {
            obj[header] = row[i];
        });
        return obj;
    });
}

// --- OTHER FUNCTIONS ---
function updateLastSeen(userId) {
  try {
    const clientsSheet = SS.getSheetByName(SHEETS.CLIENTS);
    const data = clientsSheet.getDataRange().getValues();
    const headers = data.shift();
    const idIndex = headers.indexOf('מזהה לקוח');
    const lastSeenIndex = headers.indexOf('נראה לאחרונה');

    if (idIndex === -1 || lastSeenIndex === -1) return;

    for (let i = 0; i < data.length; i++) {
      if (String(data[i][idIndex]).trim() === String(userId).trim()) {
        clientsSheet.getRange(i + 2, lastSeenIndex + 1).setValue(new Date());
        return;
      }
    }
  } catch(e) {
    console.error("Failed to update last seen status: " + e.message);
    logAction(userId, 'updateLastSeen failed', { error: e.message });
  }
}

function logAction(user, action, details) {
  try {
    const logSheet = SS.getSheetByName(SHEETS.AUDIT_LOG);
    const timestamp = new Date();
    const detailsString = JSON.stringify(details);
    logSheet.appendRow([timestamp, user, action, details.orderId || '', detailsString]);
  } catch (e) {
    console.error("Failed to write to Audit Log: " + e.message);
  }
}

