import forge from "node-forge";

/** Synthetic GOST-shaped certificate for metadata parsing tests only.
 * Its signature is intentionally invalid; never use it to test signature trust.
 */
export function makeTestGostCertificate() {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "0a112233";
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  cert.setSubject([
    { name: "commonName", value: "GOST Test Signer" },
    { name: "serialNumber", value: "IIN222222222220" },
    { name: "organizationalUnitName", value: "BIN123456789013" },
  ]);
  cert.setIssuer([{ name: "commonName", value: "Test GOST CA" }]);
  cert.setExtensions([
    { name: "keyUsage", digitalSignature: true, nonRepudiation: true },
    { name: "extKeyUsage", clientAuth: true, emailProtection: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const root = forge.pki.certificateToAsn1(cert);
  const children = (node: forge.asn1.Asn1) => node.value as forge.asn1.Asn1[];
  const oid = (value: string) => forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false, forge.asn1.oidToDer(value).getBytes());
  const sequence = (value: forge.asn1.Asn1[]) => forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, value);
  const tbs = children(root)[0];
  const offset = children(tbs)[0].tagClass === forge.asn1.Class.CONTEXT_SPECIFIC ? 1 : 0;
  children(root)[1] = sequence([oid("1.2.643.7.1.1.3.2")]);
  children(tbs)[offset + 1] = sequence([oid("1.2.643.7.1.1.3.2")]);
  children(tbs)[offset + 5] = sequence([
    sequence([oid("1.2.643.7.1.1.1.1"), sequence([oid("1.2.643.7.1.2.1.1.1")])]),
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.BITSTRING, false, "\0" + forge.asn1.toDer(forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OCTETSTRING, false, "\0".repeat(64))).getBytes()),
  ]);
  const body = Buffer.from(forge.asn1.toDer(root).getBytes(), "binary").toString("base64").match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
}
