import {
  ESF_MODULE_REQUIRED_MESSAGE,
  ESF_NCALAYER_SERVICE,
  ESF_NCALAYER_STORAGE_PKCS12,
  NCALAYER_ACCESSORY_GET_BUNDLES,
  NCALAYER_ACCESSORY_GET_SERVICES,
  NCALAYER_ACCESSORY_MODULE,
  buildEsfAuthRequest,
  buildEsfSignPlainDataRequest,
  findOfficialEsfBundle,
  findOfficialEsfService,
  extractPublicCertificateFromUnknown,
  parseEsfSignerResponse,
  sanitizeUnknownEsfResponse,
  type EsfPlainSignature,
} from "@creolab/contracts";
import { NCALAYER_URL, NcalayerError } from "./ncalayerClient.ts";

export { ESF_MODULE_REQUIRED_MESSAGE, ESF_NCALAYER_SERVICE };

export type EsfModuleProbe = {
  ncalayer: boolean;
  officialModuleInstalled: boolean;
  bundleName: string | null;
  bundleVersion: string | null;
  serviceName: string | null;
  methods: string[];
  unofficialServices: string[];
  bundles: Record<string, string>;
  services: string[];
};

function parseJson(data: string) {
  return JSON.parse(data) as unknown;
}

export class EsfNcaLayerClient {
  private socket: WebSocket | null = null;

  async connect() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return;
    this.socket = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(NCALAYER_URL);
      const timer = window.setTimeout(() => {
        ws.close();
        reject(new NcalayerError("NCALAYER_NOT_RUNNING", "NCALayer не отвечает. Запустите приложение с ncl.pki.gov.kz"));
      }, 4000);
      ws.onerror = () => {
        window.clearTimeout(timer);
        reject(new NcalayerError("NCALAYER_NOT_RUNNING", "Нет связи с NCALayer на 127.0.0.1:13579"));
      };
      ws.onmessage = () => {
        window.clearTimeout(timer);
        ws.onmessage = null;
        resolve(ws);
      };
    });
  }

  async isAvailable() {
    try {
      await this.connect();
      return true;
    } catch {
      return false;
    }
  }

  disconnect() {
    this.socket?.close();
    this.socket = null;
  }

  async probe(): Promise<EsfModuleProbe> {
    await this.connect();
    // The NCALayer protocol has one response handler and no request IDs.
    const bundlesRaw = await this.request({ module: NCALAYER_ACCESSORY_MODULE, method: NCALAYER_ACCESSORY_GET_BUNDLES });
    const servicesRaw = await this.request({ module: NCALAYER_ACCESSORY_MODULE, method: NCALAYER_ACCESSORY_GET_SERVICES });
    const bundles = (unwrapMap(bundlesRaw) || {}) as Record<string, string>;
    const services = unwrapServices(servicesRaw);
    const bundle = findOfficialEsfBundle(bundles);
    const service = findOfficialEsfService({ services }) || (services.includes(ESF_NCALAYER_SERVICE) ? ESF_NCALAYER_SERVICE : null);
    return {
      ncalayer: true,
      officialModuleInstalled: Boolean(bundle || service),
      bundleName: bundle?.name || null,
      bundleVersion: bundle?.version || null,
      serviceName: service,
      methods: service ? ["signPlainData", "signPlainDataMap", "auth"] : [],
      unofficialServices: services.filter((name) => /uchet/i.test(name)),
      bundles,
      services,
    };
  }

  async auth(data = `creolab-esf-auth-${Date.now()}`, storageName = ESF_NCALAYER_STORAGE_PKCS12) {
    const probe = await this.probe();
    if (!probe.officialModuleInstalled) {
      throw new NcalayerError("SIGNATURE_FAILED", ESF_MODULE_REQUIRED_MESSAGE);
    }
    const request = buildEsfAuthRequest(data, storageName);
    if (probe.serviceName) request.module = probe.serviceName;
    const raw = await this.request(request, 180000);
    const parsed = parseEsfSignerResponse(raw);
    const publicCertificate = (parsed.ok && parsed.publicCertificate) || extractPublicCertificateFromUnknown(raw);
    return {
      raw: sanitizeUnknownEsfResponse(raw),
      parsed: parsed.ok ? parsed : null,
      error: parsed.ok ? null : parsed,
      publicCertificate,
      keyInfo: parsed.ok ? parsed.keyInfo : null,
      hasPublicCertificate: Boolean(publicCertificate),
    };
  }

  async signPlainData(payload: string, storageName = ESF_NCALAYER_STORAGE_PKCS12): Promise<EsfPlainSignature> {
    const probe = await this.probe();
    if (!probe.officialModuleInstalled) {
      throw new NcalayerError("SIGNATURE_FAILED", ESF_MODULE_REQUIRED_MESSAGE);
    }
    const request = buildEsfSignPlainDataRequest(payload, storageName);
    if (probe.serviceName) request.module = probe.serviceName;
    const response = await this.request(request, 180000);
    const parsed = parseEsfSignerResponse(response);
    if (!parsed.ok) {
      if (parsed.code === "USER_CANCELLED") throw new NcalayerError("USER_CANCELLED", parsed.message);
      if (parsed.code === "MODULE_NOT_FOUND") throw new NcalayerError("SIGNATURE_FAILED", ESF_MODULE_REQUIRED_MESSAGE);
      throw new NcalayerError("SIGNATURE_FAILED", parsed.message);
    }
    return parsed;
  }

  private request(body: Record<string, unknown>, timeoutMs = 8000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new NcalayerError("NCALAYER_NOT_RUNNING", "Нет связи с NCALayer на 127.0.0.1:13579"));
    }
    return new Promise<unknown>((resolve, reject) => {
      const ws = this.socket!;
      const timer = window.setTimeout(() => {
        reject(new NcalayerError("SIGNATURE_FAILED", "NCALayer не ответил"));
      }, timeoutMs);
      ws.onmessage = (event) => {
        window.clearTimeout(timer);
        ws.onmessage = null;
        try {
          resolve(parseJson(String(event.data)));
        } catch {
          reject(new NcalayerError("SIGNATURE_FAILED", "NCALayer вернул некорректный ответ"));
        }
      };
      ws.onerror = () => {
        window.clearTimeout(timer);
        reject(new NcalayerError("NCALAYER_NOT_RUNNING", "Связь с NCALayer оборвалась"));
      };
      ws.send(JSON.stringify(body));
    });
  }
}

function unwrapMap(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  if (root.body && typeof root.body === "object" && root.body && "result" in (root.body as object)) {
    return (root.body as { result?: unknown }).result;
  }
  if (root.result && typeof root.result === "object") return root.result;
  return root;
}

function unwrapServices(payload: unknown): string[] {
  const value = unwrapMap(payload);
  if (Array.isArray(value)) return value.map(String);
  if (value && typeof value === "object" && Array.isArray((value as { services?: unknown }).services)) {
    return ((value as { services: unknown[] }).services || []).map(String);
  }
  return [];
}

export function createEsfNcaLayerClient() {
  return new EsfNcaLayerClient();
}
