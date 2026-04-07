using UnityEngine;
using UnityEngine.InputSystem;

public class PlayerController : MonoBehaviour
{
    private float speed = 4.5f;

    public void Start()
    {
        Debug.Log("Player ready");
    }

    public void Update()
    {
        var keyboard = Keyboard.current;
        if (keyboard == null)
        {
            return;
        }

        var move = Vector3.zero;
        if (keyboard.wKey.isPressed) move += Vector3.forward;
        if (keyboard.sKey.isPressed) move += Vector3.back;
        if (keyboard.aKey.isPressed) move += Vector3.left;
        if (keyboard.dKey.isPressed) move += Vector3.right;

        transform.position += move * speed * Time.deltaTime;
    }
}
