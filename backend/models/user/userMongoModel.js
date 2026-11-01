const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    minlength: 3,
    maxlength: 30
  },
  email: {
    type: String,
    required: false,
    trim: true,
    lowercase: true,
    validate: {
      validator: function(v) {
        // Allow null or validate as email
        return v === null || v === undefined || v === '' || 
          /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/.test(v);
      },
      message: props => "Please provide a valid email address or leave it empty"
    }
  },
  password: {
    type: String,
    required: true,
    minlength: 8,
    select: false // Don't return password by default in queries
  },
  role: {
    type: String,
    enum: ['admin', 'user'],
    default: 'user'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  tokenVersion: {
    type: Number,
    default: 0
  },
  lastLogin: {
    type: Date
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: { createdAt: false, updatedAt: true }
});

// Pre-save hook to hash passwords before saving
userSchema.pre('save', async function(next) {
  // Only hash the password if it's modified or new
  if (!this.isModified('password')) return next();
  
  try {
    // Generate salt and hash password
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Defense in depth (C5): any update path that sets a password must hash it.
// findByIdAndUpdate/findOneAndUpdate bypass the save hook otherwise.
userSchema.pre('findOneAndUpdate', async function(next) {
  try {
    const update = this.getUpdate() || {};
    const isHash = (v) => typeof v === 'string' && /^\$2[aby]\$\d{2}\$/.test(v);

    if (typeof update.password === 'string' && !isHash(update.password)) {
      update.password = await bcrypt.hash(update.password, 10);
    }
    if (update.$set && typeof update.$set.password === 'string' && !isHash(update.$set.password)) {
      update.$set.password = await bcrypt.hash(update.$set.password, 10);
    }
    this.setUpdate(update);
    next();
  } catch (error) {
    next(error);
  }
});

// Method to compare passwords
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

const User = mongoose.model('User', userSchema);

module.exports = User;