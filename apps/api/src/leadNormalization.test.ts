import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  flattenIncomingFormBody,
  normalizeLeadFromFormPayload,
  parseFieldMapping,
} from "./services/leadNormalizationService.ts";

describe("lead normalization + mapping", () => {
  it("parses flat and versioned mapping", () => {
    const flat = parseFieldMapping({ customer_name: "name", mobile: "phone" });
    assert.equal(flat.version, 1);
    assert.equal(flat.fields.customer_name, "name");

    const versioned = parseFieldMapping({
      version: 3,
      fields: { business: "company" },
    });
    assert.equal(versioned.version, 3);
    assert.equal(versioned.fields.business, "company");
    assert.equal(versioned.fields.name, "name");
  });

  it("maps custom form fields and keeps UTM", () => {
    const lead = normalizeLeadFromFormPayload({
      body: {
        customer_name: "Александр",
        mobile: "+7 701 111 22 33",
        business: "ABC",
        request_text: "Нужен сайт",
        utm_source: "google",
        utm_campaign: "brand",
        pageUrl: "https://creolab.kz/website",
        website: "",
      },
      mappingJson: {
        version: 2,
        fields: {
          customer_name: "name",
          mobile: "phone",
          business: "company",
          request_text: "message",
        },
      },
      integrationId: "int-1",
    });
    assert.equal(lead.name, "Александр");
    assert.equal(lead.phone, "+7 701 111 22 33");
    assert.equal(lead.company, "ABC");
    assert.equal(lead.message, "Нужен сайт");
    assert.equal(lead.utm?.source, "google");
    assert.equal(lead.mappingVersion, 2);
    assert.equal(lead.entryChannel, "website_form");
  });

  it("flattens Tilda urlencoded keys and ignores client company override", () => {
    const flat = flattenIncomingFormBody({
      Name: "Иван",
      Phone: "+77015550011",
      Email: "ivan@example.com",
      Comments: "Нужен сайт",
      tranid: "467251:8442970",
      formid: "form48844953",
      company_id: "other-tenant",
      responsible_user_id: "other-user",
    });
    assert.equal(flat.company_id, undefined);
    assert.equal(flat.responsible_user_id, undefined);
    const lead = normalizeLeadFromFormPayload({
      body: flat,
      mappingJson: { version: 1, fields: { name: "name", phone: "phone" } },
      integrationId: "int-tilda",
    });
    assert.equal(lead.name, "Иван");
    assert.equal(lead.phone, "+77015550011");
    assert.equal(lead.email, "ivan@example.com");
    assert.equal(lead.message, "Нужен сайт");
    assert.equal(lead.externalLeadId, "467251:8442970");
  });
});
