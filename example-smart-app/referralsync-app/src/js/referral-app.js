/**
 * ReferralSync - SMART on FHIR Referral Coordination App
 * Core Application Logic
 */

// ============================================================================
// GLOBAL STATE
// ============================================================================

let fhirClient = null;
let currentPatient = null;
let allReferrals = [];
let selectedReferral = null;

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
    try {
        console.log('🚀 Initializing ReferralSync...');

        // Initialize FHIR client from OAuth2 session
        fhirClient = await FHIR.oauth2.ready();

        console.log('✓ FHIR client ready');
        console.log('  Server:', fhirClient.state.serverUrl);
        console.log('  Patient:', fhirClient.patient.id);

        // Load patient context
        currentPatient = await fhirClient.patient.read();
        displayPatientBanner(currentPatient);

        // Hide loading, show app
        document.getElementById('loading-screen').style.display = 'none';
        document.getElementById('app').style.display = 'block';

        // Load initial data
        await loadReferrals();

        // Setup event listeners
        setupEventListeners();

        showToast('Connected to ' + (currentPatient.name?.[0]?.text || 'Patient'), 'success');

    } catch (error) {
        console.error('❌ Initialization failed:', error);
        showInitError(error);
    }
});

// ============================================================================
// PATIENT BANNER
// ============================================================================

function displayPatientBanner(patient) {
    // Name
    const name = patient.name?.[0];
    const fullName = name ? `${name.given?.join(' ') || ''} ${name.family || ''}`.trim() : 'Unknown Patient';
    document.getElementById('patient-name').textContent = fullName;

    // DOB
    const dob = patient.birthDate ? new Date(patient.birthDate).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric'
    }) : '-';
    document.getElementById('patient-dob').textContent = `DOB: ${dob}`;

    // Gender
    const gender = patient.gender ? patient.gender.charAt(0).toUpperCase() + patient.gender.slice(1) : '-';
    document.getElementById('patient-gender').textContent = gender;

    // MRN
    const mrn = patient.id || '-';
    document.getElementById('patient-mrn').textContent = `MRN: ${mrn}`;

    // Avatar
    document.getElementById('patient-avatar').textContent = patient.gender === 'female' ? '👩' : '👨';
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================

function setupEventListeners() {
    // Refresh button
    document.getElementById('refresh-btn').addEventListener('click', loadReferrals);

    // New referral button
    document.getElementById('new-referral-btn').addEventListener('click', showCreateForm);

    // Close detail view
    document.getElementById('close-detail').addEventListener('click', hideDetailView);

    // Close create form
    document.getElementById('close-form').addEventListener('click', hideCreateForm);
    document.getElementById('cancel-form').addEventListener('click', hideCreateForm);

    // Referral form submission
    document.getElementById('referral-form').addEventListener('submit', handleCreateReferral);

    // Filters
    document.getElementById('search-input').addEventListener('input', filterReferrals);
    document.getElementById('status-filter').addEventListener('change', filterReferrals);
    document.getElementById('priority-filter').addEventListener('change', filterReferrals);

    // Action buttons in detail view
    document.getElementById('accept-btn').addEventListener('click', () => updateReferralStatus('accepted'));
    document.getElementById('schedule-btn').addEventListener('click', () => updateReferralStatus('in-progress'));
    document.getElementById('cancel-btn').addEventListener('click', () => updateReferralStatus('cancelled'));
}

// ============================================================================
// LOAD REFERRALS FROM FHIR
// ============================================================================

async function loadReferrals() {
    try {
        console.log('📋 Loading referrals for patient:', currentPatient.id);

        const listEl = document.getElementById('referral-list');
        listEl.innerHTML = `
            <div class="loading-placeholder">
                <div class="loading-spinner small"></div>
                <p>Loading referrals...</p>
            </div>
        `;

        // Fetch ServiceRequests for this patient
        const response = await fhirClient.request(
            `ServiceRequest?patient=${currentPatient.id}&_count=50&_sort=-authored`
        );

        const serviceRequests = response.entry?.map(e => e.resource) || [];
        console.log(`Found ${serviceRequests.length} ServiceRequests`);

        // For each ServiceRequest, try to get associated Task
        allReferrals = await Promise.all(
            serviceRequests.map(async (sr) => {
                let task = null;
                try {
                    const taskResponse = await fhirClient.request(
                        `Task?focus=ServiceRequest/${sr.id}&_count=1`
                    );
                    task = taskResponse.entry?.[0]?.resource || null;
                } catch (e) {
                    // Task may not exist
                }

                return {
                    serviceRequest: sr,
                    task: task,
                    status: task?.status || mapServiceRequestStatus(sr.status) || 'requested'
                };
            })
        );

        // Render list
        renderReferralList(allReferrals);

        // Update stats
        updateStats(allReferrals);

    } catch (error) {
        console.error('❌ Failed to load referrals:', error);
        document.getElementById('referral-list').innerHTML = `
            <div class="no-data">
                <p>⚠️ Failed to load referrals</p>
                <p style="font-size: 13px;">${error.message}</p>
            </div>
        `;
    }
}

function mapServiceRequestStatus(srStatus) {
    const statusMap = {
        'draft': 'requested',
        'active': 'requested',
        'on-hold': 'requested',
        'completed': 'completed',
        'revoked': 'cancelled',
        'entered-in-error': 'cancelled'
    };
    return statusMap[srStatus] || 'requested';
}

// ============================================================================
// RENDER REFERRAL LIST
// ============================================================================

function renderReferralList(referrals) {
    const listEl = document.getElementById('referral-list');

    if (referrals.length === 0) {
        listEl.innerHTML = `
            <div class="no-data">
                <p>No referrals found for this patient.</p>
                <p style="font-size: 13px; margin-top: 8px;">Click "New Referral" to create one.</p>
            </div>
        `;
        return;
    }

    listEl.innerHTML = referrals.map((ref, index) => {
        const sr = ref.serviceRequest;
        const status = ref.status;
        const specialty = sr.code?.text || sr.code?.coding?.[0]?.display || 'General Referral';
        const priority = sr.priority || 'routine';
        const date = sr.authoredOn ? new Date(sr.authoredOn).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric'
        }) : '-';
        const reason = sr.reasonCode?.[0]?.text || sr.reasonCode?.[0]?.coding?.[0]?.display || '-';

        return `
            <div class="referral-card status-${status}" data-index="${index}" onclick="selectReferral(${index})">
                <div class="referral-card-header">
                    <h4>${specialty}</h4>
                    <span class="status-badge ${status}">${getStatusLabel(status)}</span>
                </div>
                <div class="referral-card-meta">
                    <span class="priority-badge ${priority}">
                        ${getPriorityIcon(priority)} ${priority.toUpperCase()}
                    </span>
                    <span>📅 ${date}</span>
                </div>
                <p style="font-size: 13px; color: var(--gray-600); margin-top: 8px; line-height: 1.4;">
                    ${truncateText(reason, 80)}
                </p>
            </div>
        `;
    }).join('');
}

function getStatusLabel(status) {
    const labels = {
        'requested': '⏳ Pending',
        'accepted': '✓ Accepted',
        'in-progress': '📅 Scheduled',
        'completed': '✓✓ Completed',
        'cancelled': '✕ Cancelled',
        'rejected': '✕ Rejected'
    };
    return labels[status] || status;
}

function getPriorityIcon(priority) {
    const icons = {
        'stat': '🔴',
        'asap': '🟠',
        'urgent': '🟡',
        'routine': '🟢'
    };
    return icons[priority] || '⚪';
}

function truncateText(text, maxLen) {
    if (!text) return '-';
    return text.length > maxLen ? text.substring(0, maxLen) + '...' : text;
}

// ============================================================================
// SELECT REFERRAL (DETAIL VIEW)
// ============================================================================

window.selectReferral = function (index) {
    selectedReferral = allReferrals[index];

    // Highlight selected card
    document.querySelectorAll('.referral-card').forEach(card => card.classList.remove('active'));
    document.querySelector(`.referral-card[data-index="${index}"]`)?.classList.add('active');

    // Show detail view
    showDetailView(selectedReferral);
};

function showDetailView(referral) {
    const sr = referral.serviceRequest;
    const status = referral.status;

    // Hide empty state and form, show detail view
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('create-form').style.display = 'none';
    document.getElementById('detail-view').style.display = 'block';

    // Populate fields
    document.getElementById('detail-specialty').textContent =
        sr.code?.text || sr.code?.coding?.[0]?.display || 'Referral';

    const statusBadge = document.getElementById('detail-status');
    statusBadge.textContent = getStatusLabel(status);
    statusBadge.className = `status-badge ${status}`;

    document.getElementById('detail-priority').textContent = (sr.priority || 'routine').toUpperCase();
    document.getElementById('detail-created').textContent = sr.authoredOn
        ? new Date(sr.authoredOn).toLocaleString() : '-';
    document.getElementById('detail-requester').textContent =
        sr.requester?.display || 'Not specified';
    document.getElementById('detail-performer').textContent =
        sr.performer?.[0]?.display || 'Not specified';
    document.getElementById('detail-reason').textContent =
        sr.reasonCode?.[0]?.text || sr.reasonCode?.[0]?.coding?.[0]?.display || 'No reason specified';
    document.getElementById('detail-notes').textContent =
        sr.note?.[0]?.text || 'No additional notes';

    // Build timeline
    buildTimeline(referral);

    // Show/hide action buttons based on status
    updateActionButtons(status);
}

function buildTimeline(referral) {
    const timeline = document.getElementById('status-timeline');
    const sr = referral.serviceRequest;

    let items = [
        {
            date: sr.authoredOn ? new Date(sr.authoredOn).toLocaleString() : 'Unknown',
            text: 'Referral Created',
            completed: true
        }
    ];

    if (referral.status === 'accepted' || referral.status === 'in-progress' || referral.status === 'completed') {
        items.push({
            date: 'Status updated',
            text: 'Referral Accepted',
            completed: true
        });
    }

    if (referral.status === 'in-progress' || referral.status === 'completed') {
        items.push({
            date: 'Scheduled',
            text: 'Appointment Scheduled',
            completed: true
        });
    }

    if (referral.status === 'completed') {
        items.push({
            date: 'Completed',
            text: 'Visit Completed',
            completed: true
        });
    }

    timeline.innerHTML = items.map((item, i) => `
        <div class="timeline-item ${item.completed ? 'completed' : ''} ${i === items.length - 1 ? 'current' : ''}">
            <div class="timeline-date">${item.date}</div>
            <div class="timeline-text">${item.text}</div>
        </div>
    `).join('');
}

function updateActionButtons(status) {
    const acceptBtn = document.getElementById('accept-btn');
    const scheduleBtn = document.getElementById('schedule-btn');
    const cancelBtn = document.getElementById('cancel-btn');

    // Reset visibility
    acceptBtn.style.display = 'none';
    scheduleBtn.style.display = 'none';
    cancelBtn.style.display = 'none';

    if (status === 'requested') {
        acceptBtn.style.display = 'inline-flex';
        cancelBtn.style.display = 'inline-flex';
    } else if (status === 'accepted') {
        scheduleBtn.style.display = 'inline-flex';
        cancelBtn.style.display = 'inline-flex';
    } else if (status === 'in-progress') {
        cancelBtn.style.display = 'inline-flex';
    }
}

function hideDetailView() {
    document.getElementById('detail-view').style.display = 'none';
    document.getElementById('empty-state').style.display = 'flex';
    document.querySelectorAll('.referral-card').forEach(card => card.classList.remove('active'));
    selectedReferral = null;
}

// ============================================================================
// CREATE REFERRAL
// ============================================================================

function showCreateForm() {
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('detail-view').style.display = 'none';
    document.getElementById('create-form').style.display = 'block';
    document.getElementById('referral-form').reset();
    document.getElementById('form-message').style.display = 'none';
}

function hideCreateForm() {
    document.getElementById('create-form').style.display = 'none';
    document.getElementById('empty-state').style.display = 'flex';
}

async function handleCreateReferral(e) {
    e.preventDefault();

    const specialty = document.getElementById('specialty').value;
    const priority = document.getElementById('priority').value;
    const reason = document.getElementById('reason').value;
    const notes = document.getElementById('notes').value;

    if (!specialty || !reason) {
        showFormMessage('Please fill in all required fields', 'error');
        return;
    }

    try {
        showFormMessage('Creating referral...', 'info');

        // Create ServiceRequest resource
        const serviceRequest = {
            resourceType: 'ServiceRequest',
            status: 'active',
            intent: 'order',
            priority: priority,
            subject: {
                reference: `Patient/${currentPatient.id}`
            },
            code: {
                text: specialty
            },
            reasonCode: [{
                text: reason
            }],
            note: notes ? [{
                text: notes,
                time: new Date().toISOString()
            }] : [],
            authoredOn: new Date().toISOString()
        };

        console.log('📤 Creating ServiceRequest:', serviceRequest);
        const srResponse = await fhirClient.create(serviceRequest);
        console.log('✓ ServiceRequest created:', srResponse.id);

        // Create Task for tracking
        const task = {
            resourceType: 'Task',
            status: 'requested',
            intent: 'order',
            priority: priority,
            focus: {
                reference: `ServiceRequest/${srResponse.id}`
            },
            for: {
                reference: `Patient/${currentPatient.id}`
            },
            authoredOn: new Date().toISOString()
        };

        console.log('📤 Creating Task:', task);
        const taskResponse = await fhirClient.create(task);
        console.log('✓ Task created:', taskResponse.id);

        showFormMessage('✓ Referral sent successfully!', 'success');
        showToast('Referral created successfully', 'success');

        // Reload and return to list
        setTimeout(async () => {
            await loadReferrals();
            hideCreateForm();
        }, 1500);

    } catch (error) {
        console.error('❌ Failed to create referral:', error);
        showFormMessage(`Failed: ${error.message}`, 'error');
        showToast('Failed to create referral', 'error');
    }
}

function showFormMessage(message, type) {
    const el = document.getElementById('form-message');
    el.textContent = message;
    el.className = `form-message ${type}`;
    el.style.display = 'block';
}

// ============================================================================
// UPDATE REFERRAL STATUS
// ============================================================================

async function updateReferralStatus(newStatus) {
    if (!selectedReferral || !selectedReferral.task) {
        showToast('Cannot update status - no task found', 'error');
        return;
    }

    try {
        console.log(`📤 Updating Task status to: ${newStatus}`);

        // Update the Task status
        const updatedTask = {
            ...selectedReferral.task,
            status: newStatus
        };

        await fhirClient.update(updatedTask);
        console.log('✓ Task updated');

        showToast(`Referral marked as ${getStatusLabel(newStatus)}`, 'success');

        // Reload referrals
        await loadReferrals();
        hideDetailView();

    } catch (error) {
        console.error('❌ Failed to update status:', error);
        showToast('Failed to update status', 'error');
    }
}

// ============================================================================
// FILTER REFERRALS
// ============================================================================

function filterReferrals() {
    const searchTerm = document.getElementById('search-input').value.toLowerCase();
    const statusFilter = document.getElementById('status-filter').value;
    const priorityFilter = document.getElementById('priority-filter').value;

    const filtered = allReferrals.filter(ref => {
        const sr = ref.serviceRequest;
        const specialty = (sr.code?.text || '').toLowerCase();
        const reason = (sr.reasonCode?.[0]?.text || '').toLowerCase();

        const matchesSearch = !searchTerm ||
            specialty.includes(searchTerm) ||
            reason.includes(searchTerm);

        const matchesStatus = !statusFilter || ref.status === statusFilter;
        const matchesPriority = !priorityFilter || sr.priority === priorityFilter;

        return matchesSearch && matchesStatus && matchesPriority;
    });

    renderReferralList(filtered);
}

// ============================================================================
// UPDATE STATS
// ============================================================================

function updateStats(referrals) {
    const pending = referrals.filter(r => r.status === 'requested').length;
    const accepted = referrals.filter(r => r.status === 'accepted').length;
    const scheduled = referrals.filter(r => r.status === 'in-progress').length;
    const completed = referrals.filter(r => r.status === 'completed').length;
    const total = referrals.length;
    const rate = total > 0 ? Math.round((completed / total) * 100) : 0;

    document.getElementById('stat-pending').textContent = pending;
    document.getElementById('stat-accepted').textContent = accepted;
    document.getElementById('stat-scheduled').textContent = scheduled;
    document.getElementById('stat-completed').textContent = completed;
    document.getElementById('stat-rate').textContent = rate + '%';
}

// ============================================================================
// TOAST NOTIFICATIONS
// ============================================================================

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <span>${getToastIcon(type)}</span>
        <span>${message}</span>
    `;

    container.appendChild(toast);

    // Auto-remove after 4 seconds
    setTimeout(() => {
        toast.style.animation = 'slideIn 0.3s ease reverse';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

function getToastIcon(type) {
    const icons = {
        'success': '✓',
        'error': '✕',
        'info': 'ℹ️',
        'warning': '⚠️'
    };
    return icons[type] || 'ℹ️';
}

// ============================================================================
// ERROR HANDLING
// ============================================================================

function showInitError(error) {
    document.getElementById('loading-screen').innerHTML = `
        <div class="loading-content">
            <div class="loading-logo">⚠️</div>
            <h1>Connection Error</h1>
            <p style="margin: 20px 0; opacity: 0.7;">Failed to initialize FHIR connection</p>
            <p style="font-size: 14px; opacity: 0.5; max-width: 400px;">${error.message}</p>
            <button onclick="location.reload()" style="
                margin-top: 30px;
                padding: 14px 28px;
                background: var(--primary);
                color: white;
                border: none;
                border-radius: 8px;
                font-size: 16px;
                cursor: pointer;
            ">Retry</button>
        </div>
    `;
}
