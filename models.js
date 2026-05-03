const mongoose = require('mongoose');

const AccountSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    userId: { type: String, required: true },
    phoneNumber: { type: String, default: 'Pending' },
    status: { type: String, default: 'waiting' },
    lastActive: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now },
    group: { type: String, default: 'Default' },
    isVisible: { type: Boolean, default: true }
});
AccountSchema.index({ userId: 1 });

const BatchSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    parentBatchId: String,
    name: { type: String, required: true },
    total: { type: Number, default: 0 },
    sentCount: { type: Number, default: 0 },
    failCount: { type: Number, default: 0 },
    status: { type: String, default: 'not_started' },
    createdBy: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    assignedTo: String
});
BatchSchema.index({ createdBy: 1 });
BatchSchema.index({ status: 1 });

const BatchItemSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    batchId: { type: String, required: true },
    number: { type: String, required: true },
    name: String,
    status: { type: String, default: 'pending' }
});
BatchItemSchema.index({ batchId: 1 });
BatchItemSchema.index({ number: 1 });

const CampaignSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    contacts: Array,
    template: String,
    media: Object,
    status: { type: String, default: 'running' },
    currentIndex: { type: Number, default: 0 },
    sentCount: { type: Number, default: 0 },
    failCount: { type: Number, default: 0 },
    createdBy: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    minDelay: Number,
    maxDelay: Number,
    accountIds: Array
});

const HistorySchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    num: { type: String, required: true },
    msg: String,
    status: String,
    accId: String,
    campName: String,
    userId: String,
    time: { type: Date, default: Date.now }
});
HistorySchema.index({ userId: 1, time: -1 });

const ContactMasterSchema = new mongoose.Schema({
    number: { type: String, required: true, unique: true },
    assigned: { type: Boolean, default: false },
    userId: String,
    batchId: String
});

const InboxSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    accId: String,
    from: String,
    text: String,
    status: { type: String, default: 'unread' },
    time: { type: Date, default: Date.now }
});

const MessageSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    accId: String,
    to: String,
    body: String,
    status: { type: String, default: 'pending' },
    time: { type: Date, default: Date.now }
});

const AssignmentSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    batchId: { type: String, required: true },
    userId: { type: String, required: true },
    status: { type: String, default: 'assigned' },
    createdAt: { type: Date, default: Date.now }
});

const UserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    name: String,
    role: { type: String, default: 'agent' },
    createdAt: { type: Date, default: Date.now }
});

module.exports = {
    User: mongoose.model('User', UserSchema),
    Account: mongoose.model('Account', AccountSchema),
    Batch: mongoose.model('Batch', BatchSchema),
    BatchItem: mongoose.model('BatchItem', BatchItemSchema),
    Campaign: mongoose.model('Campaign', CampaignSchema),
    History: mongoose.model('History', HistorySchema),
    ContactMaster: mongoose.model('ContactMaster', ContactMasterSchema),
    Inbox: mongoose.model('Inbox', InboxSchema),
    Message: mongoose.model('Message', MessageSchema),
    Assignment: mongoose.model('Assignment', AssignmentSchema)
};
