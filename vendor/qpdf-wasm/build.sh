#!/usr/bin/env bash
set -euo pipefail

: "${SOURCE_DATE_EPOCH:?SOURCE_DATE_EPOCH must be pinned by the build container}"

root=/src
prefix=/src/out
common_flags="-Oz -flto -fvisibility=hidden -ffile-prefix-map=/src=. -fdebug-prefix-map=/src=."

(
  cd "$root/zlib-1.3.2"
  CFLAGS="$common_flags" emconfigure ./configure --prefix="$prefix" --static
  emmake make -j4 libz.a
  emmake make install
)

emcmake cmake -S "$root/libjpeg-turbo-3.2.0" -B "$root/build-jpeg" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$prefix" \
  -DCMAKE_PREFIX_PATH="$prefix" \
  -DENABLE_SHARED=OFF \
  -DENABLE_STATIC=ON \
  -DWITH_SIMD=OFF \
  -DWITH_TURBOJPEG=OFF \
  -DWITH_TOOLS=OFF \
  -DWITH_TESTS=OFF \
  -DCMAKE_C_FLAGS="$common_flags"
cmake --build "$root/build-jpeg" --target install -j4

emcmake cmake -S "$root/qpdf-12.3.2" -B "$root/build-qpdf" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$prefix" \
  -DCMAKE_PREFIX_PATH="$prefix" \
  -DBUILD_SHARED_LIBS=OFF \
  -DBUILD_STATIC_LIBS=ON \
  -DBUILD_DOC=OFF \
  -DINSTALL_MANUAL=OFF \
  -DINSTALL_EXAMPLES=OFF \
  -DINSTALL_PKGCONFIG=OFF \
  -DINSTALL_CMAKE_PACKAGE=OFF \
  -DUSE_IMPLICIT_CRYPTO=OFF \
  -DREQUIRE_CRYPTO_NATIVE=ON \
  -DZLIB_H_PATH="$prefix/include" \
  -DZLIB_LIB_PATH="$prefix/lib/libz.a" \
  -DLIBJPEG_H_PATH="$prefix/include" \
  -DLIBJPEG_LIB_PATH="$prefix/lib/libjpeg.a" \
  -DCMAKE_C_FLAGS="$common_flags" \
  -DCMAKE_CXX_FLAGS="$common_flags"
cmake --build "$root/build-qpdf" --target libqpdf -j4

mkdir -p "$root/dist"
em++ \
  $common_flags \
  -L"$prefix/lib" \
  -I"$prefix/include" \
  --closure 1 \
  --pre-js "$root/pre.js" \
  --post-js "$root/post.js" \
  -s WASM_BIGINT=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s EXPORTED_RUNTIME_METHODS='["callMain","FS"]' \
  -s INCOMING_MODULE_JS_API='["noInitialRun","locateFile","print","printErr"]' \
  -s NO_DISABLE_EXCEPTION_CATCHING=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s ENVIRONMENT=node \
  -s EXIT_RUNTIME=0 \
  -s FILESYSTEM=1 \
  -o "$root/dist/qpdf.mjs" \
  "$root/build-qpdf/libqpdf/libqpdf.a" \
  "$root/qpdf-12.3.2/qpdf/qpdf.cc" \
  -I"$root/qpdf-12.3.2/include" \
  -lz \
  -ljpeg

cp "$root/BUILD-INPUTS.json" "$root/dist/BUILD-INPUTS.json"
cp -R "$root/licenses" "$root/dist/licenses"
printf '%s\n' \
  'qpdf 12.3.2' \
  'zlib 1.3.2' \
  'libjpeg-turbo 3.2.0' \
  'Emscripten 6.0.3 linux/amd64 sha256:2a7a41cd7e2065b30ba389c8db0fbeaebd7ec06bb4e20f23cab8ba92180f25c7' \
  > "$root/dist/THIRD_PARTY_VERSIONS.txt"
