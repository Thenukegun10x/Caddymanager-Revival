<template>
  <Teleport to="body">
    <div v-if="visible" class="fixed inset-0 flex items-center justify-center z-50">
      <!-- Backdrop (non-dismissible) -->
      <div class="fixed inset-0 bg-black/70"></div>

      <!-- Dialog content -->
      <div class="relative bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
        <h3 class="text-lg font-medium text-gray-900">{{ title }}</h3>
        <p class="mt-2 text-sm text-gray-500">{{ message }}</p>

        <div class="mt-6 flex gap-3">
          <button
            type="button"
            class="flex-1 inline-flex justify-center items-center px-4 py-2 bg-primary text-white rounded-md shadow-sm"
            @click="choose('json')"
          >
            JSON (API)
          </button>

          <button
            type="button"
            class="flex-1 inline-flex justify-center items-center px-4 py-2 bg-white border rounded-md shadow-sm"
            @click="choose('caddyfile')"
          >
            Caddyfile
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  modelValue: {
    type: Boolean,
    default: undefined
  },
  title: {
    type: String,
    default: 'Choose configuration type'
  },
  message: {
    type: String,
    default: 'Do you want to create a JSON (API) configuration or a Caddyfile configuration?'
  }
})

const emit = defineEmits(['update:modelValue', 'choice'])

const visible = computed(() => {
  // If parent uses v-model, respect it; otherwise, component may be mounted via v-if
  return typeof props.modelValue === 'boolean' ? props.modelValue : true
})

function choose(type) {
  emit('choice', type)
  emit('update:modelValue', false)
}
</script>

<style scoped>
/* Styling is intentionally minimal; project uses Tailwind for most layout */
</style>
