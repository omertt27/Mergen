# Homebrew formula for Mergen
# To install: brew install omertt27/mergen/mergen

class Mergen < Formula
  desc "Local-first browser observability for AI"
  homepage "https://github.com/omertt27/Mergen"
  url "https://github.com/omertt27/Mergen/archive/refs/tags/v1.4.0.tar.gz"
  sha256 "f045de08aa9e204914055efa0fe35bbf74f5ce94d71eccdc0dca16cbf4e42406"
  license "MIT"
  head "https://github.com/omertt27/Mergen.git", branch: "main"

  depends_on "node@20"

  def install
    cd "server" do
      system "npm", "install", "--production"
      system "npm", "run", "build"
    end

    # Install server
    libexec.install Dir["server/{dist,node_modules,package.json}"]

    # Install extension (for reference)
    pkgshare.install "extension"

    # Create wrapper script
    (bin/"mergen-server").write <<~EOS
      #!/bin/bash
      exec "#{Formula["node@20"].opt_bin}/node" "#{libexec}/dist/cli.js" "$@"
    EOS

    chmod 0755, bin/"mergen-server"
  end

  def post_install
    ohai "Mergen installed successfully!"
    ohai "Run 'mergen-server setup' to configure your IDE"
  end

  test do
    system bin/"mergen-server", "--version"
  end

  def caveats
    <<~EOS
      Mergen server installed!

      Quick start:
        1. Run setup: mergen-server setup
        2. Install extension (see instructions)
        3. Ask your AI: "Get recent logs"

      Documentation: https://github.com/omertt27/Mergen
    EOS
  end
end
