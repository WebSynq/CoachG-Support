// api/support-webhook.js
// Direct GHL API v2 integration — no workflow dependency
// All ticket processing happens here server-side

const GHL_BASE = 'https://services.leadconnectorhq.com';
const LOCATION_ID = process.env.GHL_LOCATION_ID || 'S3lp08bO4YltBLBZhMQy';

// ⚠️ SECURITY: Token lives in env var only — never in client code
const PRIVATE_TOKEN = process.env.GHL_PRIVATE_TOKEN;

const SUPPORT_USERS = [
  {
    id: 'jEnE1ry6QeOYv2jW1APD',
    name: 'Tim Arnold',
    email: 'timarnold@grueninghealthwealth.com'
  },
  {
    id: 'Auifnjfn1y4iUbYVhHbm',
    name: 'Michael Diaz',
    email: 'michael@grueninghealthwealth.com'
  }
];

const MATT = {
  id: '3goKC6ravKj1Zl4cLPmg',
  name: 'Matt Monacelli',
  email: 'matt@grueninghealthwealth.com'
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateTicketId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = 'TKT-';
  for (let i = 0; i < 6; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

function getRoundRobinUser(ticketCount) {
  return SUPPORT_USERS[ticketCount % SUPPORT_USERS.length];
}

function validatePayload(body) {
  const errors = [];
  if (!body.contact?.email) errors.push('contact.email required');
  if (!body.contact?.firstName) errors.push('contact.firstName required');
  if (!body.ticket?.category) errors.push('ticket.category required');
  if (!body.ticket?.priority) errors.push('ticket.priority required');
  if (!body.ticket?.description) errors.push('ticket.description required');
  if (!body.account?.name) errors.push('account.name required');
  return errors;
}

// ─── GHL API Client ───────────────────────────────────────────────────────────

async function ghl(method, endpoint, body = null) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${PRIVATE_TOKEN}`,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    }
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${GHL_BASE}${endpoint}`, opts);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(`GHL ${method} ${endpoint} → ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

// ─── GHL Operations ───────────────────────────────────────────────────────────

async function findContact(email) {
  try {
    const data = await ghl(
      'GET',
      `/contacts/search/duplicate?locationId=${LOCATION_ID}&email=${encodeURIComponent(email)}`
    );
    return data.contact || null;
  } catch {
    return null;
  }
}

async function createContact(b) {
  const data = await ghl('POST', '/contacts/', {
    locationId: LOCATION_ID,
    firstName: b.contact.firstName,
    lastName: b.contact.lastName || '',
    email: b.contact.email,
    phone: b.contact.phone || '',
    tags: ['support-user', 'new-agent-review']
  });
  return data.contact;
}

async function updateContact(contactId, b, newCount) {
  await ghl('PUT', `/contacts/${contactId}`, {
    firstName: b.contact.firstName,
    lastName: b.contact.lastName || '',
    phone: b.contact.phone || '',
    customFields: [
      { id: 'support_ticket_id',        field_value: b.ticket.id },
      { id: 'support_issue_category',   field_value: b.ticket.category },
      { id: 'support_priority',         field_value: String(b.ticket.priority) },
      { id: 'support_description',      field_value: b.ticket.description },
      { id: 'support_screenshot_url',   field_value: b.ticket.screenshot_url || '' },
      { id: 'support_steps_tried',      field_value: b.ticket.steps_tried || '' },
      { id: 'support_account_name',     field_value: b.account.name },
      { id: 'support_account_id',       field_value: b.account.id || '' },
      { id: 'support_last_ticket_date', field_value: new Date().toISOString().split('T')[0] },
      { id: 'support_status',           field_value: 'Open' },
      { id: 'support_agent_email',      field_value: b.contact.email },
      { id: 'support_sub_account_id',   field_value: b.account.id || '' },
      { id: 'support_ticket_count',     field_value: String(newCount) }
    ]
  });
}

async function addNote(contactId, b) {
  await ghl('POST', `/contacts/${contactId}/notes`, {
    userId: SUPPORT_USERS[0].id,
    body:
`Support Ticket — ${b.ticket.id}
${'─'.repeat(40)}
Category:     ${b.ticket.category}
Priority:     ${b.ticket.priority}
Issue:        ${b.ticket.description}
Steps Tried:  ${b.ticket.steps_tried || 'Not provided'}
Screenshot:   ${b.ticket.screenshot_url || 'None'}
${'─'.repeat(40)}
Agent:        ${b.contact.firstName} ${b.contact.lastName || ''}
Email:        ${b.contact.email}
Phone:        ${b.contact.phone || 'Not provided'}
Account:      ${b.account.name}
Account ID:   ${b.account.id || 'Not provided'}
Submitted:    ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CST`
  });
}

async function getPipelineStage() {
  // Use env vars if set, otherwise auto-discover by name
  if (process.env.GHL_PIPELINE_ID && process.env.GHL_STAGE_ID) {
    return {
      pipelineId: process.env.GHL_PIPELINE_ID,
      stageId: process.env.GHL_STAGE_ID
    };
  }
  const data = await ghl(
    'GET',
    `/opportunities/pipelines?locationId=${LOCATION_ID}`
  );
  const pipelines = data.pipelines || [];
  const pipeline = pipelines.find(
    p => p.name.toLowerCase().includes('coachg support') ||
         p.name.toLowerCase().includes('support')
  );
  if (!pipeline) throw new Error('Support pipeline not found in GHL');
  const stage = pipeline.stages?.find(
    s => s.name.toLowerCase().includes('new ticket')
  );
  if (!stage) throw new Error('New Ticket stage not found in pipeline');
  return { pipelineId: pipeline.id, stageId: stage.id };
}

async function createOpportunity(contactId, b, assignedUser, pipelineId, stageId) {
  const data = await ghl('POST', '/opportunities/', {
    locationId: LOCATION_ID,
    pipelineId,
    pipelineStageId: stageId,
    contactId,
    name: `${b.contact.firstName} ${b.contact.lastName || ''} — ${b.ticket.id}`.trim(),
    status: 'open',
    assignedTo: assignedUser.id,
    customFields: [
      { id: 'support_ticket_id',      field_value: b.ticket.id },
      { id: 'support_issue_category', field_value: b.ticket.category },
      { id: 'support_priority',       field_value: String(b.ticket.priority) },
      { id: 'support_description',    field_value: b.ticket.description },
      { id: 'support_screenshot_url', field_value: b.ticket.screenshot_url || '' },
      { id: 'support_steps_tried',    field_value: b.ticket.steps_tried || '' },
      { id: 'support_account_name',   field_value: b.account.name },
      { id: 'support_account_id',     field_value: b.account.id || '' }
    ]
  });
  return data.opportunity;
}

async function createTask(contactId, b, assignedUser) {
  const due = new Date();
  due.setHours(due.getHours() + 4);
  await ghl('POST', `/contacts/${contactId}/tasks`, {
    title: `[P${b.ticket.priority}] ${b.ticket.id} — ${b.ticket.category}`,
    body:
`Priority: ${b.ticket.priority}
Category: ${b.ticket.category}
Issue: ${b.ticket.description}
Steps Tried: ${b.ticket.steps_tried || 'Not provided'}
Agent: ${b.contact.firstName} ${b.contact.lastName || ''}
Account: ${b.account.name}`,
    dueDate: due.toISOString(),
    assignedTo: assignedUser.id,
    status: 'incompleted'
  });
}

async function addTags(contactId, b) {
  const tags = [
    'support-open',
    `support-priority-${b.ticket.priority}`,
    `support-${b.ticket.category.toLowerCase().replace(/\s+/g, '-')}`
  ];
  await ghl('POST', `/contacts/${contactId}/tags`, { tags });
}

async function removeTags(contactId) {
  const tags = ['support-closed', 'support-resolved', 'support-stagnant'];
  await ghl('DELETE', `/contacts/${contactId}/tags`, { tags });
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS
  const allowed = process.env.ALLOWED_ORIGIN || 'https://coach-g-support.vercel.app';
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Token check
  if (!PRIVATE_TOKEN) {
    console.error('GHL_PRIVATE_TOKEN not set');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // Validate payload
  const b = req.body;
  const errors = validatePayload(b);
  if (errors.length) {
    return res.status(400).json({ error: 'Invalid payload', details: errors });
  }

  // Generate ticket ID
  if (!b.ticket.id) b.ticket.id = generateTicketId();

  const log = (msg) => console.log(`[${b.ticket.id}] ${msg}`);

  try {
    // ── Step 1: Find or create contact ──────────────────────────────
    log('Finding contact...');
    let contact = await findContact(b.contact.email);
    let isNew = false;

    if (!contact) {
      log('Contact not found — creating...');
      contact = await createContact(b);
      isNew = true;
    } else {
      log(`Contact found: ${contact.id}`);
    }

    const contactId = contact.id;
    const currentCount = parseInt(
      contact.customFields?.find(f => f.id === 'support_ticket_count')?.value || '0'
    );
    const newCount = currentCount + 1;

    // ── Step 2: Round robin assign ───────────────────────────────────
    const assignedUser = getRoundRobinUser(currentCount);
    log(`Assigned to: ${assignedUser.name}`);

    // ── Step 3: Update contact + fields ─────────────────────────────
    log('Updating contact fields...');
    await updateContact(contactId, b, newCount);

    // ── Step 4: Tags ─────────────────────────────────────────────────
    log('Updating tags...');
    await addTags(contactId, b);
    await removeTags(contactId);

    // ── Step 5: Note ─────────────────────────────────────────────────
    log('Adding note...');
    await addNote(contactId, b);

    // ── Step 6: Get pipeline + stage ─────────────────────────────────
    log('Fetching pipeline...');
    const { pipelineId, stageId } = await getPipelineStage();

    // ── Step 7: Create opportunity ───────────────────────────────────
    log('Creating opportunity...');
    const opportunity = await createOpportunity(
      contactId, b, assignedUser, pipelineId, stageId
    );
    log(`Opportunity created: ${opportunity?.id}`);

    // ── Step 8: Create task ──────────────────────────────────────────
    log('Creating task...');
    await createTask(contactId, b, assignedUser);

    // ── Step 9: Priority 3 flag ──────────────────────────────────────
    const isUrgent = String(b.ticket.priority) === '3';
    if (isUrgent) {
      log('URGENT ticket — flagging for escalation');
      // Update contact status to Urgent
      await ghl('PUT', `/contacts/${contactId}`, {
        customFields: [
          { id: 'support_status', field_value: 'Urgent — Escalated' }
        ]
      });
    }

    // ── Done ─────────────────────────────────────────────────────────
    log('Ticket processed successfully');
    return res.status(200).json({
      success: true,
      ticketId: b.ticket.id,
      contactId,
      opportunityId: opportunity?.id,
      assignedTo: assignedUser.name,
      isNewContact: isNew,
      isUrgent
    });

  } catch (err) {
    console.error(`[${b.ticket.id}] ERROR:`, err.message);
    return res.status(500).json({
      error: 'Failed to process ticket',
      ticketId: b.ticket.id,
      detail: err.message
    });
  }
}
