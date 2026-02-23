import { useState, useEffect, useCallback } from 'react';
import api from '../lib/ipc';
import type { AppConfig } from '@shared/types';

export function useConfig() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api()
      .loadConfig()
      .then((c) => {
        setConfig(c);
        setLoading(false);
      });
  }, []);

  const save = useCallback(async (newConfig: AppConfig) => {
    await api().saveConfig(newConfig);
    setConfig(newConfig);
  }, []);

  const reload = useCallback(async () => {
    const c = await api().loadConfig();
    setConfig(c);
    return c;
  }, []);

  return { config, loading, save, reload };
}
