import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.InetSocketAddress;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.security.Provider;
import java.security.Security;
import java.security.cert.CertPathValidatorException;
import java.security.cert.CertificateRevokedException;
import java.security.cert.X509CRL;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collection;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * CMS GOST verify + OCSP/CRL via official NCA Kalkan / knca_provider_util.
 * Does not sign, does not load .p12 / PIN. Bind localhost only.
 *
 * java -cp apps/api/kalkan-verify VerifyServer
 * KALKAN_LIB_DIR=/path/to/nca/sdk/lib
 * KALKAN_VERIFY_PORT=4170
 * KALKAN_OCSP=1
 * KALKAN_OCSP_URL=   optional override of knca.ocspresponderURL
 * KALKAN_CA_DIR=     extra CA .cer/.crt besides cacerts.jks in knca_provider_util
 * KALKAN_CRL_DIR=    optional local CRLs
 */
public final class VerifyServer {
  public static void main(String[] args) throws Exception {
    String libDir = env("KALKAN_LIB_DIR", "");
    if (libDir.isEmpty()) {
      System.err.println("KALKAN_LIB_DIR is required (official NCA Kalkan jars). No .p12/PIN.");
      System.exit(2);
    }
    System.setProperty("sun.net.client.defaultConnectTimeout", "5000");
    System.setProperty("sun.net.client.defaultReadTimeout", "5000");
    String ocspUrl = env("KALKAN_OCSP_URL", "");
    if (!ocspUrl.isEmpty()) System.setProperty("knca.ocspresponderURL", ocspUrl);

    URLClassLoader loader = jarsLoader(libDir);
    // Fail at startup if the installed SDK cannot serve real verification requests.
    Class<?> providerCl = Class.forName("kz.gov.pki.kalkan.jce.provider.KalkanProvider", true, loader);
    Provider provider = (Provider) providerCl.getDeclaredConstructor().newInstance();
    if (Security.getProvider(provider.getName()) == null) Security.addProvider(provider);
    Class.forName("kz.gov.pki.kalkan.jce.provider.cms.CMSSignedData", true, loader);
    Class.forName("kz.gov.pki.provider.utils.PKIXUtil", true, loader);
    if (loadCaCerts(loader, new CmsCrypto()).isEmpty()) throw new IllegalStateException("No installed CA certificates");
    int port = Integer.parseInt(env("KALKAN_VERIFY_PORT", "4170"));
    String secret = env("KALKAN_VERIFY_SECRET", "");
    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
    server.createContext("/verify", exchange -> handle(exchange, loader, secret));
    // Loopback-only readiness: confirms SDK and CA loading, not external OCSP availability.
    server.createContext("/health", exchange -> send(exchange, ocspEnabled() ? 200 : 503,
        "{\"status\":\"ready\",\"authorityCheckEnabled\":" + ocspEnabled() + "}"));
    server.start();
    System.out.println("Kalkan CMS verify http://127.0.0.1:" + port + "/verify ocsp=" + (ocspEnabled() ? "on" : "off"));
  }

  private static void handle(HttpExchange exchange, URLClassLoader loader, String secret) throws IOException {
    if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
      send(exchange, 404, jsonResult(false, "FAILED", "UNCHECKED", "not_found"));
      return;
    }
    if (!secret.isEmpty()) {
      String auth = String.valueOf(exchange.getRequestHeaders().getFirst("Authorization"));
      if (!auth.equals("Bearer " + secret)) {
        send(exchange, 401, jsonResult(false, "FAILED", "UNCHECKED", "unauthorized"));
        return;
      }
    }
    String body = new String(readAll(exchange.getRequestBody()), StandardCharsets.UTF_8);
    String cmsB64 = jsonString(body, "cmsBase64");
    String docB64 = jsonString(body, "documentBase64");
    if (cmsB64.isEmpty() || docB64.isEmpty()) {
      send(exchange, 400, jsonResult(false, "FAILED", "UNCHECKED", "cms_or_document_missing"));
      return;
    }
    try {
      CmsCrypto crypto = verifyCms(
          loader,
          Base64.getDecoder().decode(cmsB64.replaceAll("\\s+", "")),
          Base64.getDecoder().decode(docB64.replaceAll("\\s+", "")));
      if (!crypto.ok) {
        send(exchange, 200, jsonResult(false, "FAILED", "UNCHECKED", "cms_verify_failed"));
        return;
      }
      Authority authority = checkAuthority(loader, crypto);
      boolean ok = "VALID".equals(authority.status);
      send(exchange, 200, jsonResult(ok, "VERIFIED", authority.status, authority.error));
    } catch (ClassNotFoundException e) {
      send(exchange, 503, jsonResult(false, "UNAVAILABLE", "UNCHECKED", "kalkan_jars_missing"));
    } catch (Exception e) {
      send(exchange, 200, jsonResult(false, "FAILED", "UNCHECKED", "cms_verify_failed"));
    }
  }

  static final class CmsCrypto {
    boolean ok;
    final List<X509Certificate> signerCerts = new ArrayList<>();
    final List<X509Certificate> allCerts = new ArrayList<>();
  }

  static final class Authority {
    final String status;
    final String error;

    Authority(String status, String error) {
      this.status = status;
      this.error = error;
    }
  }

  /**
   * NCA forum pattern: KalkanProvider + CMSSignedData, detached content = original file bytes.
   */
  static CmsCrypto verifyCms(ClassLoader loader, byte[] cmsDer, byte[] document) throws Exception {
    CmsCrypto result = new CmsCrypto();
    Class<?> providerCl = Class.forName("kz.gov.pki.kalkan.jce.provider.KalkanProvider", true, loader);
    Provider provider = (Provider) providerCl.getDeclaredConstructor().newInstance();
    if (Security.getProvider(provider.getName()) == null) Security.addProvider(provider);

    Class<?> cmsCl = Class.forName("kz.gov.pki.kalkan.jce.provider.cms.CMSSignedData", true, loader);
    Class<?> procCl = Class.forName("kz.gov.pki.kalkan.jce.provider.cms.CMSProcessableByteArray", true, loader);
    Object parsed = cmsCl.getConstructor(byte[].class).newInstance((Object) cmsDer);
    Method getSignedContent = cmsCl.getMethod("getSignedContent");
    Method getEncoded = cmsCl.getMethod("getEncoded");
    Object encoded = getEncoded.invoke(parsed);
    Object cms;
    if (getSignedContent.invoke(parsed) != null) {
      // Only detached signatures bind the signature to the supplied contract bytes.
      return result;
    } else {
      Object processable = procCl.getConstructor(byte[].class).newInstance((Object) document);
      Constructor<?> detached = null;
      for (Constructor<?> ctor : cmsCl.getConstructors()) {
        Class<?>[] params = ctor.getParameterTypes();
        if (params.length == 2 && params[0].isInstance(processable) && params[1] == byte[].class) {
          detached = ctor;
          break;
        }
      }
      if (detached == null) throw new ClassNotFoundException("CMSSignedData detached constructor");
      cms = detached.newInstance(processable, encoded);
    }

    Object signers = cmsCl.getMethod("getSignerInfos").invoke(cms);
    Method getSigners = signers.getClass().getMethod("getSigners");
    Collection<?> signerInfos = (Collection<?>) getSigners.invoke(signers);
    if (signerInfos == null || signerInfos.size() != 1) return result;

    Method getCerts = cmsCl.getMethod("getCertificatesAndCRLs", String.class, String.class);
    Object certStore = getCerts.invoke(cms, "Collection", provider.getName());
    boolean allOk = true;
    Set<X509Certificate> seen = new LinkedHashSet<>();
    Class<?> sidClass = null;
    for (Object signer : signerInfos) {
      Object sid = signer.getClass().getMethod("getSID").invoke(signer);
      sidClass = sid.getClass();
      Collection<?> certs = (Collection<?>) certStore.getClass().getMethod("getCertificates", java.security.cert.CertSelector.class).invoke(certStore, sid);
      if (certs == null || certs.isEmpty()) return result;
      Iterator<?> certIt = certs.iterator();
      while (certIt.hasNext()) {
        X509Certificate cert = (X509Certificate) certIt.next();
        Boolean ok = (Boolean) signer.getClass().getMethod("verify", X509Certificate.class, String.class).invoke(signer, cert, provider.getName());
        allOk = allOk && Boolean.TRUE.equals(ok);
        result.signerCerts.add(cert);
        if (seen.add(cert)) result.allCerts.add(cert);
      }
    }
    try {
      Method getAll = null;
      for (Method method : certStore.getClass().getMethods()) {
        if (!"getCertificates".equals(method.getName()) || method.getParameterCount() != 1) continue;
        if (sidClass != null && method.getParameterTypes()[0] == sidClass) continue;
        getAll = method;
        break;
      }
      if (getAll != null) {
        Collection<?> storeCerts = (Collection<?>) getAll.invoke(certStore, new Object[] { null });
        if (storeCerts != null) {
          for (Object item : storeCerts) {
            if (item instanceof X509Certificate) {
              X509Certificate extra = (X509Certificate) item;
              if (seen.add(extra)) result.allCerts.add(extra);
            }
          }
        }
      }
    } catch (Exception ignored) {
      /* signer certs are enough for OCSP */
    }
    result.ok = allOk;
    return result;
  }

  static Authority checkAuthority(ClassLoader loader, CmsCrypto crypto) {
    if (!ocspEnabled()) return new Authority("UNCHECKED", "nca_authority_adapter_missing");
    if (crypto.signerCerts.isEmpty()) return new Authority("UNCHECKED", "signer_cert_missing");
    try {
      List<X509Certificate> caCerts = loadCaCerts(loader, crypto);
      if (caCerts.isEmpty()) return new Authority("UNCHECKED", "ca_certs_missing");
      Authority ocsp = null;
      for (X509Certificate cert : crypto.signerCerts) {
        ocsp = checkOne(loader, cert, caCerts);
        if ("REVOKED".equals(ocsp.status) || "VALID".equals(ocsp.status)) return ocsp;
      }
      return ocsp != null ? ocsp : new Authority("UNCHECKED", "ocsp_unchecked");
    } catch (ClassNotFoundException e) {
      return new Authority("UNCHECKED", "knca_util_missing");
    } catch (Exception e) {
      if (isRevoked(e)) return new Authority("REVOKED", "certificate_revoked");
      return new Authority("UNCHECKED", "ocsp_unchecked");
    }
  }

  private static Authority checkOne(ClassLoader loader, X509Certificate cert, List<X509Certificate> caCerts) throws Exception {
    try {
      runPkix(loader, cert, caCerts, null, true);
      return new Authority("VALID", null);
    } catch (Exception ocspError) {
      if (isRevoked(ocspError)) return new Authority("REVOKED", "certificate_revoked");
      String ocspCode = exceptionCode(ocspError);
      List<X509CRL> crls = loadCrls(loader, cert);
      if (crls.isEmpty()) {
        if (ocspCode.contains("ISSUER_CERT_NOT_FOUND") || ocspCode.contains("NO_CACERT")) {
          return new Authority("UNCHECKED", "issuer_cert_not_found");
        }
        return new Authority("UNCHECKED", "ocsp_unreachable");
      }
      try {
        runPkix(loader, cert, caCerts, crls, false);
        return new Authority("VALID", null);
      } catch (Exception crlError) {
        if (isRevoked(crlError)) return new Authority("REVOKED", "certificate_revoked");
        return new Authority("UNCHECKED", "crl_unchecked");
      }
    }
  }

  @SuppressWarnings("unchecked")
  private static List<X509Certificate> loadCaCerts(ClassLoader loader, CmsCrypto crypto) throws Exception {
    List<X509Certificate> caCerts = new ArrayList<>();
    try {
      Class<?> ksUtil = Class.forName("kz.gov.pki.provider.utils.KeyStoreUtil", true, loader);
      Object defaults = ksUtil.getMethod("getDefaultCACerts").invoke(null);
      if (defaults instanceof Collection) caCerts.addAll((Collection<X509Certificate>) defaults);
    } catch (ClassNotFoundException e) {
      throw e;
    } catch (Exception ignored) {
      /* extra CA dir can still work */
    }
    Provider provider = Security.getProvider("KALKAN");
    File caDir = new File(env("KALKAN_CA_DIR", ""));
    if (caDir.isDirectory()) {
      File[] files = caDir.listFiles((d, name) -> {
        String lower = name.toLowerCase(Locale.ROOT);
        return lower.endsWith(".cer") || lower.endsWith(".crt") || lower.endsWith(".pem") || lower.endsWith(".der");
      });
      if (files != null) {
        Class<?> x509 = Class.forName("kz.gov.pki.provider.utils.X509Util", true, loader);
        Method load = x509.getMethod("loadX509Certificate", String.class, Provider.class);
        for (File file : files) {
          try {
            Object cert = load.invoke(null, file.getAbsolutePath(), provider);
            if (cert instanceof X509Certificate) caCerts.add((X509Certificate) cert);
          } catch (Exception ignored) {
            /* skip unreadable CA file */
          }
        }
      }
    }
    // CA trust comes only from the installed NCA roots and administrator configuration.
    // Certificates supplied in an untrusted CMS must never become trust anchors.
    return caCerts;
  }

  @SuppressWarnings("unchecked")
  private static List<X509CRL> loadCrls(ClassLoader loader, X509Certificate cert) {
    List<X509CRL> crls = new ArrayList<>();
    Provider provider = Security.getProvider("KALKAN");
    try {
      Class<?> x509 = Class.forName("kz.gov.pki.provider.utils.X509Util", true, loader);
      File crlDir = new File(env("KALKAN_CRL_DIR", ""));
      if (crlDir.isDirectory()) {
        File[] files = crlDir.listFiles((d, name) -> name.toLowerCase(Locale.ROOT).endsWith(".crl"));
        Method loadFile = x509.getMethod("loadX509CRL", String.class, Provider.class);
        if (files != null) {
          for (File file : files) {
            try {
              Object crl = loadFile.invoke(null, file.getAbsolutePath(), provider);
              if (crl instanceof X509CRL) crls.add((X509CRL) crl);
            } catch (Exception ignored) {
              /* skip unreadable CRL */
            }
          }
        }
      }
      Method urls = x509.getMethod("getCrlURLs", X509Certificate.class, boolean.class);
      Method loadUrl = x509.getMethod("loadX509CRL", URL.class, Provider.class);
      Object listed = urls.invoke(null, cert, Boolean.TRUE);
      if (listed instanceof Collection) {
        for (Object item : (Collection<Object>) listed) {
          if (!(item instanceof URL)) continue;
          try {
            Object crl = loadUrl.invoke(null, item, provider);
            if (crl instanceof X509CRL) crls.add((X509CRL) crl);
          } catch (Exception ignored) {
            /* CDP unreachable */
          }
        }
      }
    } catch (Exception ignored) {
      /* CRL optional */
    }
    return crls;
  }

  private static void runPkix(
      ClassLoader loader,
      X509Certificate cert,
      Collection<X509Certificate> caCerts,
      Collection<X509CRL> crls,
      boolean ocsp
  ) throws Exception {
    Class<?> pkixCl = Class.forName("kz.gov.pki.provider.utils.PKIXUtil", true, loader);
    Object pkix = pkixCl.getConstructor(X509Certificate.class, Collection.class).newInstance(cert, caCerts);
    if (ocsp) pkixCl.getMethod("withOCSP").invoke(pkix);
    if (crls != null && !crls.isEmpty()) pkixCl.getMethod("withCRL", Collection.class).invoke(pkix, crls);
    try {
      pkixCl.getMethod("validate").invoke(pkix);
    } catch (InvocationTargetException e) {
      Throwable cause = e.getCause() != null ? e.getCause() : e;
      if (cause instanceof Exception) throw (Exception) cause;
      throw e;
    }
  }

  private static boolean isRevoked(Throwable error) {
    for (Throwable cur = error; cur != null; cur = cur.getCause()) {
      if (cur instanceof CertificateRevokedException) return true;
      if (cur instanceof CertPathValidatorException) {
        CertPathValidatorException.Reason reason = ((CertPathValidatorException) cur).getReason();
        if (reason == CertPathValidatorException.BasicReason.REVOKED) return true;
      }
      String name = cur.getClass().getSimpleName().toLowerCase(Locale.ROOT);
      String msg = String.valueOf(cur.getMessage()).toLowerCase(Locale.ROOT);
      String code = exceptionCode(cur).toLowerCase(Locale.ROOT);
      if (name.contains("revok") || msg.contains("revok") || code.contains("revok")) return true;
    }
    return false;
  }

  private static String exceptionCode(Throwable error) {
    for (Throwable cur = error; cur != null; cur = cur.getCause()) {
      try {
        Method getCode = cur.getClass().getMethod("getCode");
        Object code = getCode.invoke(cur);
        if (code != null) return String.valueOf(code);
      } catch (Exception ignored) {
        /* not ProviderUtilException */
      }
    }
    return "";
  }

  private static boolean ocspEnabled() {
    String value = env("KALKAN_OCSP", "1").toLowerCase(Locale.ROOT);
    return !(value.equals("0") || value.equals("false") || value.equals("off"));
  }

  private static URLClassLoader jarsLoader(String libDir) throws Exception {
    File dir = new File(libDir);
    File[] files = dir.isDirectory() ? dir.listFiles((d, name) -> name.endsWith(".jar")) : null;
    List<URL> urls = new ArrayList<>();
    if (files != null) {
      for (File file : files) urls.add(file.toURI().toURL());
    }
    if (urls.isEmpty()) throw new IllegalStateException("No jars in KALKAN_LIB_DIR");
    return new URLClassLoader(urls.toArray(new URL[0]), VerifyServer.class.getClassLoader());
  }

  private static String jsonString(String json, String key) {
    String needle = "\"" + key + "\"";
    int at = json.indexOf(needle);
    if (at < 0) return "";
    int colon = json.indexOf(':', at + needle.length());
    int first = json.indexOf('"', colon + 1);
    if (colon < 0 || first < 0) return "";
    int end = first + 1;
    StringBuilder out = new StringBuilder();
    boolean escape = false;
    while (end < json.length()) {
      char ch = json.charAt(end);
      if (escape) {
        out.append(ch);
        escape = false;
      } else if (ch == '\\') {
        escape = true;
      } else if (ch == '"') {
        break;
      } else {
        out.append(ch);
      }
      end += 1;
    }
    return out.toString();
  }

  private static String jsonResult(boolean ok, String crypto, String authority, String error) {
    StringBuilder out = new StringBuilder(160);
    out.append("{\"ok\":").append(ok);
    out.append(",\"cryptoStatus\":\"").append(crypto).append('"');
    out.append(",\"authorityStatus\":\"").append(authority).append('"');
    if (error != null && !error.isEmpty()) {
      out.append(",\"error\":\"").append(error.replace("\\", "\\\\").replace("\"", "\\\"")).append('"');
    }
    out.append('}');
    return out.toString();
  }

  private static byte[] readAll(InputStream in) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    byte[] buf = new byte[8192];
    int n;
    while ((n = in.read(buf)) >= 0) out.write(buf, 0, n);
    return out.toByteArray();
  }

  private static void send(HttpExchange exchange, int status, String json) throws IOException {
    byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
    exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
    exchange.sendResponseHeaders(status, bytes.length);
    try (OutputStream os = exchange.getResponseBody()) {
      os.write(bytes);
    }
  }

  private static String env(String name, String fallback) {
    String value = System.getenv(name);
    return value == null || value.trim().isEmpty() ? fallback : value.trim();
  }
}
