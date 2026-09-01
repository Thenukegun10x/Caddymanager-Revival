import axios from 'axios';
import config from './configService';
import apiService from './apiService';

// Get base API URL from environment or use default
const API_URL = config.API.BASE_URL;
const AUTH_ENDPOINT = `${API_URL}/auth`;

// Get token from localStorage (fallback, httpOnly cookie is primary — Set F)
const getToken = () => localStorage.getItem(config.STORAGE.AUTH_TOKEN_KEY);

// Set authorization header — only if token exists (httpOnly path uses withCredentials cookie)
const setAuthHeader = () => {
  const token = getToken();
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
};

// Service methods
export default {
  // Login user — httpOnly cookie set by backend, do NOT persist token in localStorage (XSS mitigation, Set F)
  login: async (credentials) => {
    try {
      const response = await apiService.post(`/auth/login`, {
        username: credentials.username,
        password: credentials.password
      });
      
      if (response.data.user) {
        localStorage.setItem(config.STORAGE.USER_KEY || 'user', JSON.stringify(response.data.user));
        // Keep token only in memory for non-cookie clients (not persisted)
        if (response.data.token) {
          window.__auth_token = response.data.token;
        }
        // Remove any legacy token from localStorage if present
        localStorage.removeItem(config.STORAGE.AUTH_TOKEN_KEY);
      }
      return response.data;
    } catch (error) {
      throw error.response ? error.response.data : { message: error.message };
    }
  },

  // Logout user — clear httpOnly cookie via backend + local state
  logout: async () => {
    try { await apiService.post(`/auth/logout`); } catch (_) {}
    localStorage.removeItem(config.STORAGE.AUTH_TOKEN_KEY);
    localStorage.removeItem(config.STORAGE.USER_KEY || 'user');
    window.__auth_token = null;
  },

  // Get current user
  getCurrentUser: async () => {
    try {
      const response = await apiService.get(`/auth/me`);
      return response.data;
    } catch (error) {
      throw error.response ? error.response.data : { message: error.message };
    }
  },

  // Update user profile
  updateProfile: async (profileData) => {
    try {
      const response = await apiService.put(`/auth/update-profile`, profileData);
      if (response.data.user) {
        localStorage.setItem(config.STORAGE.USER_KEY || 'user', JSON.stringify(response.data.user));
      }
      return response.data;
    } catch (error) {
      throw error.response ? error.response.data : { message: error.message };
    }
  },

  // Change password
  changePassword: async (passwordData) => {
    try {
      const response = await apiService.put(`/auth/change-password`, passwordData);
      return response.data;
    } catch (error) {
      throw error.response ? error.response.data : { message: error.message };
    }
  },

  // Check if user is logged in — via user object (httpOnly cookie is primary)
  isLoggedIn: () => {
    try {
      const user = localStorage.getItem(config.STORAGE.USER_KEY || 'user');
      return !!user;
    } catch { return false; }
  },

  // Get current authenticated user from localStorage (guard JSON parse)
  getUser: () => {
    try {
      const user = localStorage.getItem(config.STORAGE.USER_KEY || 'user');
      return user ? JSON.parse(user) : null;
    } catch {
      localStorage.removeItem(config.STORAGE.USER_KEY || 'user');
      return null;
    }
  },

  // Admin: Get all users
  getAllUsers: async () => {
    try {
      const response = await apiService.get(`/auth/users`);
      return response.data;
    } catch (error) {
      throw error.response ? error.response.data : { message: error.message };
    }
  },

  // Admin: Update user role
  updateUserRole: async (userData) => {
    try {
      const response = await apiService.put(`/auth/update-user-role`, userData);
      return response.data;
    } catch (error) {
      throw error.response ? error.response.data : { message: error.message };
    }
  },
  
  // Admin: Create a new user (for admin use)
  createUser: async (userData) => {
    try {
      const response = await apiService.post(`/auth/create-user`, userData);
      return response.data;
    } catch (error) {
      throw error.response ? error.response.data : { message: error.message };
    }
  },
  
  // Admin: Delete a user
  deleteUser: async (userId) => {
    try {
      const response = await apiService.delete(`/auth/delete-user/${userId}`);
      return response.data;
    } catch (error) {
      throw error.response ? error.response.data : { message: error.message };
    }
  }
};