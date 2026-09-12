/** Official NCALayer Basics: https://github.com/pkigovkz/sdkinfo/wiki/KNCA-Basics-Module */
export const NCALAYER_MODULE = "kz.gov.pki.knca.basics";
export const NCALAYER_SIGN = "sign";
export const NCALAYER_URL = "wss://127.0.0.1:13579/";
export const NCALAYER_FORMAT_CMS = "cms";
export const NCALAYER_FORMAT_XML = "xml";
/** Official wiki: подпись */
export const NCALAYER_EKU_SIGN = "1.3.6.1.5.5.7.3.4";
/** Official wiki: аутентификация */
export const NCALAYER_EKU_AUTH = "1.3.6.1.5.5.7.3.2";

export type NcalayerErrorCode =
  | "NCALAYER_NOT_RUNNING"
  | "USER_CANCELLED"
  | "CERTIFICATE_NOT_SELECTED"
  | "SIGNATURE_FAILED"
  | "CERTIFICATE_EXPIRED";

export class NcalayerError extends Error {
  code: NcalayerErrorCode;
  canceledByUser: boolean;

  constructor(code: NcalayerErrorCode, message: string) {
    super(message);
    this.code = code;
    this.canceledByUser = code === "USER_CANCELLED";
  }
}

export type CertificateInfo = {
  commonName?: string;
  iin?: string;
  bin?: string;
};

export interface SigningClient {
  connect(): Promise<void>;
  getCertificateInfo(): Promise<CertificateInfo | null>;
  signData(dataBase64: string): Promise<string>;
  signDocument(documentBase64: string): Promise<string>;
  disconnect(): void;
}

type BasicsResponse = {
  status?: boolean;
  code?: string;
  message?: string;
  details?: string;
  body?: { result?: string };
  result?: { version?: string };
};

function mapNcalayerFailure(payload: BasicsResponse): NcalayerError {
  const text = `${payload.message || ""} ${payload.code || ""} ${payload.details || ""}`.toLowerCase();
  if (/cancel|отмен|denied by user|user.?cancel/.test(text)) {
    return new NcalayerError("USER_CANCELLED", payload.message || "Подпись отменена");
  }
  if (/expired|истёк|истек/.test(text)) {
    return new NcalayerError("CERTIFICATE_EXPIRED", payload.message || "Срок действия сертификата истёк");
  }
  if (/not.?select|не выбран|certificate/.test(text) && /select|выбор/.test(text)) {
    return new NcalayerError("CERTIFICATE_NOT_SELECTED", payload.message || "Сертификат не выбран");
  }
  return new NcalayerError("SIGNATURE_FAILED", payload.message || payload.code || "Подпись отклонена NCALayer");
}

export class NCALayerSigningClient implements SigningClient {
  private socket: WebSocket | null = null;
  private lastCms: string | null = null;

  async connect() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return;
    try {
      this.socket = await new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(NCALAYER_URL);
        const timer = window.setTimeout(() => {
          ws.close();
          reject(new NcalayerError("NCALAYER_NOT_RUNNING", "NCALayer не отвечает. Запустите приложение с ncl.pki.gov.kz"));
        }, 4000);
        ws.onopen = () => {
          /* handshake message comes next */
        };
        ws.onerror = () => {
          window.clearTimeout(timer);
          reject(new NcalayerError("NCALAYER_NOT_RUNNING", "Нет связи с NCALayer на 127.0.0.1:13579"));
        };
        ws.onmessage = (event) => {
          window.clearTimeout(timer);
          try {
            const payload = JSON.parse(String(event.data)) as BasicsResponse;
            if (payload.result?.version || payload.status !== false) {
              ws.onmessage = null;
              resolve(ws);
              return;
            }
          } catch {
            /* first frame may be empty */
          }
          ws.onmessage = null;
          resolve(ws);
        };
      });
    } catch (error) {
      if (error instanceof NcalayerError) throw error;
      throw new NcalayerError("NCALAYER_NOT_RUNNING", "Нет связи с NCALayer на 127.0.0.1:13579");
    }
  }

  async isAvailable() {
    try {
      await this.connect();
      return true;
    } catch (error) {
      if (error instanceof NcalayerError && error.code === "NCALAYER_NOT_RUNNING") return false;
      return false;
    }
  }

  async getCertificateInfo(): Promise<CertificateInfo | null> {
    if (!this.lastCms) return null;
    return null;
  }

  signData(dataBase64: string) {
    return this.signCms(dataBase64);
  }

  signDocument(documentBase64: string) {
    return this.signCms(documentBase64);
  }

  /** Official basics format=cms. Used for contracts. */
  async signCms(
    dataBase64: string,
    options?: { extKeyUsageOids?: string[]; encapsulate?: boolean },
  ) {
    const cms = await this.invokeSign({
      format: NCALAYER_FORMAT_CMS,
      data: dataBase64,
      signingParams: {
        decode: true,
        encapsulate: options?.encapsulate === true,
        digested: false,
      },
      extKeyUsageOids: options?.extKeyUsageOids || [NCALAYER_EKU_SIGN],
    });
    this.lastCms = cms;
    return cms;
  }

  /** Official basics format=xml. Not used for contract CMS. */
  signXml(xml: string, options?: { extKeyUsageOids?: string[] }) {
    return this.invokeSign({
      format: NCALAYER_FORMAT_XML,
      data: xml,
      signingParams: {},
      extKeyUsageOids: options?.extKeyUsageOids || [NCALAYER_EKU_SIGN],
    });
  }

  /**
   * Official basics.sign with AUTH EKU (1.3.6.1.5.5.7.3.2).
   * Returns CMS so backend can extract the public certificate only.
   * This is not SessionService createSessionSigned.
   */
  selectAuthCertificate() {
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    return this.signCms(nonce, { extKeyUsageOids: [NCALAYER_EKU_AUTH], encapsulate: true });
  }

  disconnect() {
    this.socket?.close();
    this.socket = null;
  }

  private async invokeSign(input: {
    format: "cms" | "xml";
    data: string;
    signingParams: Record<string, unknown>;
    extKeyUsageOids: string[];
  }) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      await this.connect();
    }
    const request = {
      module: NCALAYER_MODULE,
      method: NCALAYER_SIGN,
      args: {
        allowedStorages: ["PKCS12", "AKKaztokenStore", "AKKZIDCardStore"],
        format: input.format,
        data: input.data,
        signingParams: input.signingParams,
        signerParams: {
          extKeyUsageOids: input.extKeyUsageOids,
        },
        locale: "ru",
      },
    };
    return new Promise<string>((resolve, reject) => {
      const ws = this.socket!;
      const timer = window.setTimeout(
        () => reject(new NcalayerError("SIGNATURE_FAILED", "NCALayer не ответил на подпись")),
        120000,
      );
      ws.onmessage = (event) => {
        window.clearTimeout(timer);
        ws.onmessage = null;
        let payload: BasicsResponse;
        try {
          payload = JSON.parse(String(event.data)) as BasicsResponse;
        } catch {
          reject(new NcalayerError("SIGNATURE_FAILED", "NCALayer вернул некорректный ответ"));
          return;
        }
        if (payload.status === false) {
          reject(mapNcalayerFailure(payload));
          return;
        }
        const result = payload.body?.result;
        if (!result) {
          reject(new NcalayerError("USER_CANCELLED", "Подпись отменена"));
          return;
        }
        resolve(result);
      };
      ws.onerror = () => {
        window.clearTimeout(timer);
        reject(new NcalayerError("NCALAYER_NOT_RUNNING", "Связь с NCALayer оборвалась"));
      };
      ws.send(JSON.stringify(request));
    });
  }
}

export function createSigningClient(): SigningClient {
  return new NCALayerSigningClient();
}

export function createNcalayerClient() {
  return new NCALayerSigningClient();
}
