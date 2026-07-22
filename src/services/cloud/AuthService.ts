import { injectable } from '@/fw/di';
import { appState } from '@/state';
import * as ApiClient from '@/services/cloud/ApiClient';

@injectable()
export class AuthService {
  async restoreSession(): Promise<void> {
    appState.auth.isLoading = true;
    try {
      const user = await ApiClient.getMe();
      appState.auth.user = user;
      appState.auth.isAuthenticated = true;
    } catch {
      appState.auth.user = null;
      appState.auth.isAuthenticated = false;
    } finally {
      appState.auth.isLoading = false;
    }
  }

  async login(email: string, password: string): Promise<void> {
    appState.auth.isLoading = true;
    try {
      const user = await ApiClient.login(email, password);
      appState.auth.user = user;
      appState.auth.isAuthenticated = true;
    } finally {
      appState.auth.isLoading = false;
    }
  }

  async register(email: string, username: string, password: string): Promise<void> {
    appState.auth.isLoading = true;
    try {
      const user = await ApiClient.register(email, username, password);
      appState.auth.user = user;
      appState.auth.isAuthenticated = true;
    } finally {
      appState.auth.isLoading = false;
    }
  }

  async logout(): Promise<void> {
    try {
      await ApiClient.logout();
    } finally {
      appState.auth.user = null;
      appState.auth.isAuthenticated = false;
    }
  }
}
