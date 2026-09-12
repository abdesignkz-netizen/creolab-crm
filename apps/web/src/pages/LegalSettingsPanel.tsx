import { notifySaved } from "../components/SaveNotice";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";

type Profile = {
  legalName: string | null;
  bin: string | null;
  legalAddress: string | null;
  iban: string | null;
  bankName: string | null;
  bik: string | null;
  directorName: string | null;
  directorPosition: string | null;
  defaultVatMode: "none" | "percent" | null;
  defaultVatRate: number | null;
  documentsEnabled: boolean;
  contractSigningEnabled: boolean;
  esfIntegrationEnabled: boolean;
  defaultCatalogTruId: string | null;
  vatConfigured: boolean;
};

const EMPTY: Profile = {
  legalName: "",
  bin: "",
  legalAddress: "",
  iban: "",
  bankName: "",
  bik: "",
  directorName: "",
  directorPosition: "",
  defaultVatMode: null,
  defaultVatRate: null,
  documentsEnabled: true,
  contractSigningEnabled: false,
  esfIntegrationEnabled: false,
  defaultCatalogTruId: "",
  vatConfigured: false,
};

export function LegalSettingsPanel() {
  const [profile, setProfile] = useState<Profile>(EMPTY);
  const [vatChoice, setVatChoice] = useState<"unset" | "none" | "12" | "custom">("unset");
  const [customRate, setCustomRate] = useState("12");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [preflight, setPreflight] = useState<any>(null);

  function applyLoaded(data: Profile) {
    setProfile({ ...EMPTY, ...data });
    if (!data.defaultVatMode) {
      setVatChoice("unset");
    } else if (data.defaultVatMode === "none") {
      setVatChoice("none");
    } else if (Number(data.defaultVatRate) === 12) {
      setVatChoice("12");
    } else {
      setVatChoice("custom");
      setCustomRate(String(data.defaultVatRate ?? ""));
    }
  }

  async function loadPreflight() {
    try {
      setPreflight(await api.esfPreflight());
    } catch {
      setPreflight(null);
    }
  }

  useEffect(() => {
    void api
      .legalProfile()
      .then((data) => applyLoaded(data as Profile))
      .catch((err) => setError(err instanceof Error ? err.message : "Не удалось загрузить реквизиты"));
    void loadPreflight();
  }, []);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const defaultVatMode = vatChoice === "unset" ? null : vatChoice === "none" ? "none" : "percent";
      const defaultVatRate =
        vatChoice === "12" ? 12 : vatChoice === "custom" ? Number(String(customRate).replace(",", ".")) : vatChoice === "none" ? 0 : null;
      const next = (await api.updateLegalProfile({
        legalName: profile.legalName || null,
        bin: profile.bin || null,
        legalAddress: profile.legalAddress || null,
        iban: profile.iban || null,
        bankName: profile.bankName || null,
        bik: profile.bik || null,
        directorName: profile.directorName || null,
        directorPosition: profile.directorPosition || null,
        defaultVatMode,
        defaultVatRate,
        documentsEnabled: profile.documentsEnabled,
        contractSigningEnabled: profile.contractSigningEnabled,
        esfIntegrationEnabled: profile.esfIntegrationEnabled,
        defaultCatalogTruId: profile.defaultCatalogTruId || null,
      })) as Profile;
      applyLoaded(next);
      setEditing(false);
      notifySaved("Реквизиты сохранены");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <b>Реквизиты и НДС</b>
      <p className="muted">
        Эти данные пойдут в договор, счёт, АВР и ЭСФ. Ставка НДС по умолчанию подставляется в новые позиции сделки,
        пока менеджер не укажет другую.
      </p>
      {error ? <p className="error">{error}</p> : null}
      {!editing ? <div className="saved-editor-summary">
        <p>{profile.legalName || "Организация"}{profile.bin ? ` · БИН ${profile.bin}` : ""}</p>
        <button type="button" className="btn secondary" autoFocus onClick={() => setEditing(true)}>Изменить реквизиты</button>
      </div> : <>
      <div className="deal-edit">
        <label>
          Юридическое название
          <input
            value={profile.legalName || ""}
            onChange={(e) => setProfile({ ...profile, legalName: e.target.value })}
          />
        </label>
        <label>
          БИН
          <input value={profile.bin || ""} onChange={(e) => setProfile({ ...profile, bin: e.target.value })} />
        </label>
        <label>
          Юридический адрес
          <input
            value={profile.legalAddress || ""}
            onChange={(e) => setProfile({ ...profile, legalAddress: e.target.value })}
          />
        </label>
        <label>
          Банк
          <input value={profile.bankName || ""} onChange={(e) => setProfile({ ...profile, bankName: e.target.value })} />
        </label>
        <label>
          ИИК / IBAN
          <input value={profile.iban || ""} onChange={(e) => setProfile({ ...profile, iban: e.target.value })} />
        </label>
        <label>
          БИК
          <input value={profile.bik || ""} onChange={(e) => setProfile({ ...profile, bik: e.target.value })} />
        </label>
        <label>
          Директор
          <input
            value={profile.directorName || ""}
            onChange={(e) => setProfile({ ...profile, directorName: e.target.value })}
          />
        </label>
        <label>
          Должность директора
          <input
            value={profile.directorPosition || ""}
            onChange={(e) => setProfile({ ...profile, directorPosition: e.target.value })}
          />
        </label>
        <label>
          Идентификатор ТРУ (G 18)
          <input
            value={profile.defaultCatalogTruId || ""}
            onChange={(e) => setProfile({ ...profile, defaultCatalogTruId: e.target.value })}
            placeholder="Из справочника ИС ЭСФ, не выдумывать"
          />
        </label>
        <label>
          НДС по умолчанию
          <select value={vatChoice} onChange={(e) => setVatChoice(e.target.value as typeof vatChoice)}>
            <option value="unset">Не выбрано — не подставлять автоматически</option>
            <option value="none">Без НДС</option>
            <option value="12">12%</option>
            <option value="custom">Своя ставка</option>
          </select>
        </label>
        {vatChoice === "custom" ? (
          <label>
            Ставка, %
            <input value={customRate} onChange={(e) => setCustomRate(e.target.value)} />
          </label>
        ) : null}
        <label>
          <input
            type="checkbox"
            checked={profile.documentsEnabled}
            onChange={(e) => setProfile({ ...profile, documentsEnabled: e.target.checked })}
          />{" "}
          Черновики договора, счёта, АВР и ЭСФ. Раздел «Документы» в меню
        </label>
        <label>
          <input
            type="checkbox"
            checked={profile.contractSigningEnabled}
            onChange={(e) => setProfile({ ...profile, contractSigningEnabled: e.target.checked })}
          />{" "}
          Подписание договора ЭЦП (NCALayer)
        </label>
        <label>
          <input
            type="checkbox"
            checked={profile.esfIntegrationEnabled}
            onChange={(e) => setProfile({ ...profile, esfIntegrationEnabled: e.target.checked })}
          />{" "}
          Контур ИС ЭСФ включён. Подключение кабинета — в{" "}
          <Link to="/integrations/esf">Интеграции → ИС ЭСФ</Link>, не путь к ЭЦП и не PIN.
        </label>
        {preflight ? (
          <div className={preflight.ready ? "banner" : "banner warn"} style={{ marginTop: 12 }}>
            <b>{preflight.ready ? "TEST ИС ЭСФ готов к живой отправке" : "TEST ИС ЭСФ ещё не готов"}</b>
            <p className="muted">{preflight.nextStep}</p>
            <p className="muted">
              {preflight.esfEnv} · {preflight.provider}
              {preflight.probes?.localService?.reachable ? " · Kalkan доступен" : " · Kalkan нет"}
              {preflight.probes?.esfHost?.reachable ? " · хост КГД доступен" : " · хост КГД нет"}
            </p>
            {(preflight.blockers || []).length ? (
              <ul>
                {(preflight.blockers as string[]).map((row) => (
                  <li key={row}>{row}</li>
                ))}
              </ul>
            ) : null}
            <button type="button" className="btn secondary" disabled={busy} onClick={() => void loadPreflight()}>
              Проверить снова
            </button>
          </div>
        ) : null}
      </div>
      <div className="actions" style={{ marginTop: 12 }}>
        <button type="button" className="btn" disabled={busy} onClick={() => void save()}>
          {busy ? "Сохраняем…" : "Сохранить реквизиты"}
        </button>
      </div>
      </>}
    </div>
  );
}
