<template>
  <div>
    <nav style="padding:12px; border-bottom:1px solid #eee; display:flex; gap:12px;">
      <router-link to="/">Streaming Demo</router-link>
      <router-link to="/diff">Diff Editor Demo</router-link>
    </nav>
    <main style="padding:12px">
      <router-view />
    </main>
  </div>
</template>

<script setup lang="ts">
// Layout only
</script>

<style scoped>
nav a { color: #3b82f6; text-decoration: none }
nav a.router-link-active { font-weight: 600 }
</style>
