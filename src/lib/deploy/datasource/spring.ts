import type { RepoFile } from "../github";

/**
 * Spring/JVM datasource coercion — H2 dev DB → managed Postgres.
 *
 * Generated Spring apps ship an H2 dev datasource: `org.h2.Driver` pinned in
 * application.properties with H2 the only DB dependency. The pipeline injects a
 * Postgres jdbc URL (and, via db-env.ts, the driver/dialect override), but the
 * env override only takes effect if the Postgres driver is actually on the
 * classpath and nothing still hard-codes H2. This guarantees both:
 *
 *   1. add `org.postgresql:postgresql` to pom.xml / build.gradle, and
 *   2. flip a pinned H2 driver/dialect to Postgres in application.properties|yml.
 *
 * Without it HikariCP boots org.h2.Driver, rejects the jdbc:postgresql URL, and
 * the whole context fails (entityManagerFactory → userRepository → 0 machines).
 */
export function coerceSpringDatasource(files: RepoFile[]): { files: RepoFile[]; notes: string[] } {
  const notes: string[] = [];
  const out = files.map((f) => {
    // Maven: add a runtime Postgres driver dependency if absent.
    if (/(^|\/)pom\.xml$/.test(f.path)) {
      if (/org\.postgresql/.test(f.content) || !/<dependencies>/.test(f.content)) return f;
      const dep =
        "    <dependency>\n" +
        "      <groupId>org.postgresql</groupId>\n" +
        "      <artifactId>postgresql</artifactId>\n" +
        "      <scope>runtime</scope>\n" +
        "    </dependency>\n";
      notes.push("Spring: added org.postgresql:postgresql (runtime) to pom.xml so the Postgres driver is on the classpath.");
      return { path: f.path, content: f.content.replace(/(<dependencies>\s*\n)/, `$1${dep}`) };
    }

    // Gradle: add a runtimeOnly Postgres driver if absent.
    if (/(^|\/)build\.gradle(\.kts)?$/.test(f.path)) {
      if (/org\.postgresql:postgresql/.test(f.content) || !/dependencies\s*\{/.test(f.content)) return f;
      const line = f.path.endsWith(".kts")
        ? '    runtimeOnly("org.postgresql:postgresql")\n'
        : "    runtimeOnly 'org.postgresql:postgresql'\n";
      notes.push("Spring: added runtimeOnly org.postgresql:postgresql to build.gradle so the Postgres driver is on the classpath.");
      return { path: f.path, content: f.content.replace(/(dependencies\s*\{\s*\n)/, `$1${line}`) };
    }

    // application.properties: flip a pinned H2 driver/dialect to Postgres.
    if (/(^|\/)application(-[\w]+)?\.properties$/.test(f.path) && /org\.h2\.Driver|H2Dialect/.test(f.content)) {
      const content = f.content
        .replace(/^(spring\.datasource\.driver-class-name\s*=\s*).*org\.h2\.Driver.*$/gim, "$1org.postgresql.Driver")
        .replace(/^(spring\.jpa\.(?:database-platform|properties\.hibernate\.dialect)\s*=\s*).*H2Dialect.*$/gim, "$1org.hibernate.dialect.PostgreSQLDialect");
      if (content !== f.content) {
        notes.push(`Spring: re-pointed hard-coded H2 driver/dialect to Postgres in ${f.path}.`);
        return { path: f.path, content };
      }
    }

    // application.yml: same, for the YAML form.
    if (/(^|\/)application(-[\w]+)?\.ya?ml$/.test(f.path) && /org\.h2\.Driver|H2Dialect/.test(f.content)) {
      const content = f.content
        .replace(/org\.h2\.Driver/g, "org.postgresql.Driver")
        .replace(/org\.hibernate\.dialect\.H2Dialect/g, "org.hibernate.dialect.PostgreSQLDialect");
      if (content !== f.content) {
        notes.push(`Spring: re-pointed hard-coded H2 driver/dialect to Postgres in ${f.path}.`);
        return { path: f.path, content };
      }
    }

    return f;
  });
  return { files: out, notes };
}
