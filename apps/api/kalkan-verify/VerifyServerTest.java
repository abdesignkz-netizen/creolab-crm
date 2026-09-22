import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPairGenerator;
import java.security.Security;
import java.security.cert.CertStore;
import java.security.cert.CollectionCertStoreParameters;
import java.util.Date;
import java.util.List;
import javax.security.auth.x500.X500Principal;
import kz.gov.pki.kalkan.jce.provider.KalkanProvider;
import kz.gov.pki.kalkan.jce.provider.cms.CMSProcessableByteArray;
import kz.gov.pki.kalkan.jce.provider.cms.CMSSignedDataGenerator;
import kz.gov.pki.kalkan.x509.X509V3CertificateGenerator;

/** Offline regression test using the installed official Kalkan SDK.
 * Compile this file and VerifyServer.java with kalkan.jar on the classpath, then run
 * VerifyServerTest with the same classpath. Optional argument: scratch output directory.
 * Keys are generated in memory; synthetic certificates are not trusted NCA certificates.
 */
public final class VerifyServerTest {
  public static void main(String[] args) throws Exception {
    Security.addProvider(new KalkanProvider());
    check("RSA", 2048, "SHA256WithRSAEncryption", CMSSignedDataGenerator.DIGEST_SHA256, args);
    check("ECGOST3410-2015", 256, "1.2.398.3.10.1.1.2.3.1", CMSSignedDataGenerator.DIGEST_GOST3411_2015_256, args);
  }

  static void check(String keyAlgorithm, int bits, String signatureAlgorithm, String digest, String[] args) throws Exception {
    var generator = KeyPairGenerator.getInstance(keyAlgorithm, "KALKAN");
    generator.initialize(bits);
    var keys = generator.generateKeyPair();
    var certificate = new X509V3CertificateGenerator();
    certificate.setSerialNumber(BigInteger.valueOf(12345));
    var name = new X500Principal("CN=Synthetic Signer, SERIALNUMBER=IIN222222222220, OU=BIN123456789013");
    certificate.setSubjectDN(name);
    certificate.setIssuerDN(name);
    certificate.setNotBefore(new Date(System.currentTimeMillis() - 60_000));
    certificate.setNotAfter(new Date(System.currentTimeMillis() + 3_600_000));
    certificate.setPublicKey(keys.getPublic());
    certificate.setSignatureAlgorithm(signatureAlgorithm);
    var cert = certificate.generate(keys.getPrivate(), "KALKAN");
    var cms = new CMSSignedDataGenerator();
    cms.addSigner(keys.getPrivate(), cert, digest);
    cms.addCertificatesAndCRLs(CertStore.getInstance("Collection", new CollectionCertStoreParameters(List.of(cert))));
    byte[] document = "Synthetic contract; no real agreement".getBytes(StandardCharsets.UTF_8);
    byte[] detached = cms.generate(new CMSProcessableByteArray(document), false, "KALKAN").getEncoded();
    var loader = VerifyServerTest.class.getClassLoader();
    if (!VerifyServer.verifyCms(loader, detached, document).ok) throw new AssertionError("Matching bytes rejected: " + keyAlgorithm);
    boolean wrongAccepted = false;
    try {
      wrongAccepted = VerifyServer.verifyCms(loader, detached, "Another document".getBytes(StandardCharsets.UTF_8)).ok;
    } catch (Exception expected) {
      // The SDK may throw on a signed-attribute digest mismatch.
    }
    if (wrongAccepted) throw new AssertionError("Different bytes accepted: " + keyAlgorithm);
    byte[] attached = cms.generate(new CMSProcessableByteArray(document), true, "KALKAN").getEncoded();
    if (VerifyServer.verifyCms(loader, attached, document).ok) throw new AssertionError("Attached CMS accepted: " + keyAlgorithm);
    if (args.length > 0) {
      Files.write(Path.of(args[0], keyAlgorithm + ".der"), detached);
      Files.write(Path.of(args[0], keyAlgorithm + "-document"), document);
    }
    System.out.println(keyAlgorithm + ": matching bytes accepted; different bytes and attached CMS rejected");
  }
}
