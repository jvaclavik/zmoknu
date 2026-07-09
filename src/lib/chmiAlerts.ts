// Klient pro výstrahy ČHMÚ (viz api/chmi-alerts.ts). Chyby polkne → jen prázdno.

export interface ChmiAlert {
  event: string;
  eventEn: string;
  level: number; // 1–4
  color: string; // green/yellow/orange/red
  type: string;
  onset: string;
  expires: string;
  description: string;
  descriptionEn: string;
}

export async function fetchChmiAlerts(
  lat: number,
  lon: number,
): Promise<ChmiAlert[]> {
  try {
    const res = await fetch(
      `/api/chmi-alerts?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`,
    );
    if (!res.ok) return [];
    const d = (await res.json()) as { alerts?: ChmiAlert[] };
    return Array.isArray(d.alerts) ? d.alerts : [];
  } catch {
    return [];
  }
}
