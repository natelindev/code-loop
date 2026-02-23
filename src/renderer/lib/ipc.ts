import type { ElectronAPI } from '../../preload/index';

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

const api = (): ElectronAPI => window.electronAPI;
export default api;
