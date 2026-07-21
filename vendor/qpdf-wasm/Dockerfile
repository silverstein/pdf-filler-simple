FROM emscripten/emsdk@sha256:2a7a41cd7e2065b30ba389c8db0fbeaebd7ec06bb4e20f23cab8ba92180f25c7 AS build

WORKDIR /src
ENV SOURCE_DATE_EPOCH=1769277252
ENV TZ=UTC
ENV LC_ALL=C

COPY sources/qpdf-12.3.2.tar.gz sources/zlib-1.3.2.tar.gz sources/libjpeg-turbo-3.2.0.tar.gz ./
COPY sources.lock.json BUILD-INPUTS.json
COPY licenses licenses
COPY build.sh pre.js post.js ./

RUN echo "6cba2f9f2cd887d905faeb99e0e51a307b217920d1bbf3e9cfbb2e8178a2deda  qpdf-12.3.2.tar.gz" | sha256sum -c - \
 && echo "bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16  zlib-1.3.2.tar.gz" | sha256sum -c - \
 && echo "6f30092cef9fb839779646608f4ee14ae3cbac989c47fa05e841b0841f09878e  libjpeg-turbo-3.2.0.tar.gz" | sha256sum -c - \
 && tar -xzf qpdf-12.3.2.tar.gz \
 && tar -xzf zlib-1.3.2.tar.gz \
 && tar -xzf libjpeg-turbo-3.2.0.tar.gz \
 && ./build.sh

FROM scratch AS export
COPY --from=build /src/dist /
