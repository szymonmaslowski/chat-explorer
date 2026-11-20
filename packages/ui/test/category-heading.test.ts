import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import NoteCategoryHeading from '../src/components/NoteCategoryHeading.vue';

const heading = (props: Partial<InstanceType<typeof NoteCategoryHeading>['$props']> = {}) =>
  mount(NoteCategoryHeading, {
    props: { name: 'Dairy', count: 2, ticked: null, collapsed: false, ...props },
  });

describe('category heading', () => {
  it('shows the name and the count, and folds from the whole row but the rename button', async () => {
    const wrapper = heading();
    expect(wrapper.find('.name').text()).toBe('Dairy');
    expect(wrapper.find('.count').text()).toBe('2');
    await wrapper.find('.toggle').trigger('click');
    expect(wrapper.emitted('toggle')).toHaveLength(1);
    await wrapper.find('[aria-label="Rename category"]').trigger('click');
    expect(wrapper.emitted('toggle')).toHaveLength(1);
  });

  it('renames with the typed name and keeps showing a name afterwards', async () => {
    const wrapper = heading();
    await wrapper.find('[aria-label="Rename category"]').trigger('click');
    const input = wrapper.find('input');
    expect((input.element as HTMLInputElement).value).toBe('Dairy');
    await input.setValue(' Nabiał ');
    await wrapper.find('form').trigger('submit');
    expect(wrapper.emitted('rename')).toEqual([['Nabiał']]);
    expect(wrapper.find('.name').text()).toBe('Dairy');
  });

  it('does not rename to an empty or unchanged name', async () => {
    const wrapper = heading();
    await wrapper.find('[aria-label="Rename category"]').trigger('click');
    await wrapper.find('input').setValue('   ');
    await wrapper.find('form').trigger('submit');
    await wrapper.find('[aria-label="Rename category"]').trigger('click');
    await wrapper.find('form').trigger('submit');
    expect(wrapper.emitted('rename')).toBeUndefined();
  });
});
