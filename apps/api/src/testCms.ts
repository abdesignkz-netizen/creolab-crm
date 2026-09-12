import forge from "node-forge";

export function makeTestCms(
  document: Buffer,
  options: { iin?: string; bin?: string; expired?: boolean } = {},
) {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "0a1b2c";
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = options.expired ? new Date(Date.now() - 1000) : new Date(Date.now() + 365 * 86400000);
  cert.setSubject([
    { name: "commonName", value: "Test Signer" },
    { name: "serialNumber", value: `IIN${options.iin || "222222222220"}` },
    { name: "organizationalUnitName", value: `BIN${options.bin || "123456789013"}` },
  ]);
  cert.setIssuer([{ name: "commonName", value: "Test CA" }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(document.toString("binary"));
  p7.addCertificate(cert);
  p7.addSigner({
    key: keys.privateKey,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
  });
  p7.sign({ detached: true });
  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return Buffer.from(der, "binary").toString("base64");
}
