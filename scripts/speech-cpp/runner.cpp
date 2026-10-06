// Offline RU/KK decoder. stdin: LE u32 chunk count, then (u32 samples, float32 PCM).
#include "whisper.h"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdint>
#include <iostream>
#include <memory>
#include <string>
#include <vector>
#ifdef __linux__
#include <sys/prctl.h>
#include <signal.h>
#include <unistd.h>
#endif

static int fail(const char * code) {
    std::cout << "{\"error\":\"" << code << "\"}\n";
    return 1;
}

static void write_text(const std::string & text) {
    std::cout << "{\"text\":\"";
    for (unsigned char c : text) {
        if (c == '"' || c == '\\') std::cout << '\\' << c;
        else if (c < 0x20) {
            char escaped[7]; std::snprintf(escaped, sizeof(escaped), "\\u%04x", c);
            std::cout << escaped;
        } else std::cout << c;
    }
    std::cout << "\"}\n";
}

int main(int argc, char ** argv) {
#ifdef __linux__
    // Also stop if the Python parent crashes outside the normal group cancellation.
    const auto parent = getppid();
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 || parent == 1 || getppid() != parent)
        return fail("voice_local_failed");
#endif
    if (argc != 2) return fail("voice_service_config");
    try {
        constexpr size_t limit = 120 * 16000;
        uint32_t count = 0;
        if (std::fread(&count, sizeof(count), 1, stdin) != 1 || count == 0 || count > 600)
            return fail("voice_unsupported");
        size_t total = 0;
        std::vector<std::vector<float>> chunks;
        for (uint32_t i = 0; i < count; ++i) {
            uint32_t samples = 0;
            if (std::fread(&samples, sizeof(samples), 1, stdin) != 1 || samples == 0)
                return fail("voice_unsupported");
            if (samples > 30 * 16000 || total + samples > limit) return fail("voice_too_long");
            total += samples;
            chunks.emplace_back(samples);
            if (std::fread(chunks.back().data(), sizeof(float), samples, stdin) != samples)
                return fail("voice_unsupported");
            for (float x : chunks.back()) if (!std::isfinite(x)) return fail("voice_unsupported");
        }
        if (std::fgetc(stdin) != EOF || std::ferror(stdin)) return fail("voice_unsupported");
        double energy = 0;
        for (const auto & chunk : chunks) for (float x : chunk) energy += double(x) * x;
        if (energy / total < 1e-10) return fail("voice_empty");
        whisper_log_set([](ggml_log_level, const char *, void *) {}, nullptr);
        auto cp = whisper_context_default_params();
        cp.use_gpu = false;
        cp.flash_attn = true;
        std::unique_ptr<whisper_context, decltype(&whisper_free)> ctx(
            whisper_init_from_file_with_params(argv[1], cp), whisper_free);
        if (!ctx) return fail("voice_local_failed");
        // Select only between RU and KK, even when a third language ranks first.
        const int threads = 2;
        const int ru = whisper_lang_id("ru"), kk = whisper_lang_id("kk");
        std::vector<float> probabilities(whisper_lang_max_id() + 1);
        const auto & detection = *std::max_element(chunks.begin(), chunks.end(),
            [](const auto & a, const auto & b) { return a.size() < b.size(); });
        if (whisper_pcm_to_mel(ctx.get(), detection.data(), detection.size(), threads) != 0 ||
            whisper_lang_auto_detect(ctx.get(), 0, threads, probabilities.data()) < 0)
            return fail("voice_local_failed");
        auto params = whisper_full_default_params(WHISPER_SAMPLING_BEAM_SEARCH);
        params.n_threads = threads;
        params.language = probabilities[kk] > probabilities[ru] ? "kk" : "ru";
        params.translate = false;
        params.no_context = true;
        params.print_progress = params.print_realtime = params.print_timestamps = params.print_special = false;
        params.beam_search.beam_size = 5;
        params.greedy.best_of = 1;
        std::string text;
        for (const auto & audio : chunks) {
            if (whisper_full(ctx.get(), params, audio.data(), audio.size()) != 0)
                return fail("voice_local_failed");
            if (!text.empty()) text += ' ';
            for (int i = 0; i < whisper_full_n_segments(ctx.get()); ++i) {
                text += whisper_full_get_segment_text(ctx.get(), i);
                if (text.size() > 48000) return fail("voice_too_long");
            }
        }
        if (text.find_first_not_of(" \t\r\n") == std::string::npos) return fail("voice_empty");
        write_text(text);
        return 0;
    } catch (const std::bad_alloc &) { return fail("voice_resources"); }
      catch (...) { return fail("voice_local_failed"); }
}
