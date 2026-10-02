# Test certificates

Test-only certificates shaped like Caddy's local certificate authority: a root, an intermediate it
issued, and a site certificate the intermediate issued for auth.syntax.test, lab.syntax.test, and
syntax.test. `other_root.crt` is an unrelated root. They last 100 years, and nothing trusts them;
`leaf.key` exists only so the tests' stand-in for Caddy can serve `leaf.crt`.

They were made with OpenSSL 3:

```sh
for name in root intermediate leaf other_root; do
	openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out $name.key
done
openssl req -x509 -new -key root.key -subj "/CN=Test Local Authority - Root" -days 36500 \
	-addext basicConstraints=critical,CA:true -addext keyUsage=critical,keyCertSign,cRLSign -out root.crt
openssl req -x509 -new -key other_root.key -subj "/CN=Other Local Authority - Root" -days 36500 \
	-addext basicConstraints=critical,CA:true -addext keyUsage=critical,keyCertSign,cRLSign \
	-out other_root.crt
openssl req -new -key intermediate.key -subj "/CN=Test Local Authority - Intermediate" -out i.csr
printf 'basicConstraints=critical,CA:true,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n' > i.ext
openssl x509 -req -in i.csr -CA root.crt -CAkey root.key -days 36500 -extfile i.ext \
	-out intermediate.crt
openssl req -new -key leaf.key -subj "/CN=auth.syntax.test" -out l.csr
printf 'subjectAltName=DNS:auth.syntax.test,DNS:lab.syntax.test,DNS:syntax.test\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature\n' > l.ext
openssl x509 -req -in l.csr -CA intermediate.crt -CAkey intermediate.key -days 36500 \
	-extfile l.ext -out leaf.crt
```
